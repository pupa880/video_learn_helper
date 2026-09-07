"""用户库：列表不截断、进度/对话/字幕落盘、IndexedDB 迁入。"""

from fastapi.testclient import TestClient

from app import state
from app.server import create_app


def test_list_videos_unlimited_and_sorted(tmp_path, monkeypatch):
    videos = tmp_path / "videos"
    monkeypatch.setattr(state, "VIDEOS_DIR", videos)
    for i, name in enumerate(["甲", "乙", "丙"]):
        vid = f"{i:012x}"
        d = videos / vid
        d.mkdir(parents=True)
        state.save_meta(vid, {"name": name, "source": "local", "updated_at": 100 + i})
    listed = state.list_videos()
    assert [v["name"] for v in listed] == ["丙", "乙", "甲"]
    assert all("position" in v for v in listed)


def test_patch_position_and_chat_history(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "VIDEOS_DIR", tmp_path / "videos")
    client = TestClient(create_app())
    created = client.post("/api/video/create", json={"name": "课", "source": "local"}).json()
    vid = created["id"]

    patch = client.patch(f"/api/video/{vid}", json={"position": 42.5, "touch": True})
    assert patch.status_code == 200
    assert patch.json()["position"] == 42.5

    detail = client.get(f"/api/video/{vid}")
    assert detail.status_code == 200
    assert detail.json()["position"] == 42.5
    assert detail.json()["summary"] is None

    cues = [{"start": 1.0, "end": 2.0, "text": "你好"}]
    put_sub = client.put(f"/api/subtitle/{vid}", json={"cues": cues})
    assert put_sub.status_code == 200
    got = client.get(f"/api/subtitle/{vid}").json()
    assert got["cues"] == cues

    msgs = [
        {"role": "user", "content": "讲了啥", "ui": {"text": "讲了啥"}},
        {"role": "assistant", "content": "开场白"},
    ]
    put_chat = client.put(f"/api/chat/{vid}/history", json={"messages": msgs})
    assert put_chat.status_code == 200
    hist = client.get(f"/api/chat/{vid}/history").json()
    assert hist["messages"][0]["ui"]["text"] == "讲了啥"
    assert hist["messages"][1]["content"] == "开场白"

    listed = client.get("/api/video/list").json()["videos"]
    assert any(v["id"] == vid for v in listed)


def test_import_library_merges_chat_and_cues(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "VIDEOS_DIR", tmp_path / "videos")
    client = TestClient(create_app())
    vid = "0123456789ab"
    resp = client.post("/api/video/import", json={
        "id": vid,
        "name": "导入课",
        "source": "bilibili",
        "url": "https://bilibili.com/video/BV1xx",
        "page": 2,
        "position": 15,
        "cues": [{"start": 1.0, "end": 2.0, "text": "你好"}],
        "summary": "这是总结",
        "messages": [{"role": "user", "content": "hi", "ui": {"text": "hi"}}],
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == vid
    assert body["position"] == 15
    assert body["has_subtitles"] is True
    assert body["has_chat"] is True
    assert state.load_summary(vid) == "这是总结"
    assert state.load_chat(vid)[0]["ui"]["text"] == "hi"


def test_parse_srt_endpoint_does_not_need_video_id():
    client = TestClient(create_app())
    srt = "1\n00:00:01,000 --> 00:00:02,000\n你好\n"
    resp = client.post(
        "/api/subtitle/parse",
        files={"file": ("a.srt", srt.encode("utf-8"), "application/x-subrip")},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 1
    assert data["cues"][0]["text"] == "你好"


def test_video_status_unknown_id_is_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "VIDEOS_DIR", tmp_path / "videos")
    client = TestClient(create_app())
    resp = client.get("/api/video/aaaaaaaaaaaa/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["has_file"] is False
    assert body["has_audio"] is False


def test_bilibili_subtitle_requires_url():
    client = TestClient(create_app())
    resp = client.post("/api/subtitle/bilibili", json={"url": ""})
    assert resp.status_code == 400


def test_history_page_served():
    client = TestClient(create_app())
    resp = client.get("/history")
    assert resp.status_code == 200
    assert "按标题搜索" in resp.text


def test_compress_endpoint_rejects_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "VIDEOS_DIR", tmp_path / "videos")
    client = TestClient(create_app())
    resp = client.post("/api/chat/compress", json={"messages": []})
    assert resp.status_code == 400


def test_delete_video_removes_chat(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "VIDEOS_DIR", tmp_path / "videos")
    client = TestClient(create_app())
    vid = client.post("/api/video/create", json={"name": "删"}).json()["id"]
    client.put(f"/api/chat/{vid}/history", json={"messages": [{"role": "user", "content": "x"}]})
    assert client.delete(f"/api/video/{vid}").status_code == 200
    assert client.get(f"/api/video/{vid}").status_code == 404
    assert client.get(f"/api/chat/{vid}/history").json()["messages"] == []
