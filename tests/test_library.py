"""用户库迁移导出、字幕解析接口（不写用户库）。"""

from fastapi.testclient import TestClient

from app import state
from app.server import create_app
from app.services.subtitle import Cue


def test_export_library_includes_cues_and_summary(tmp_path, monkeypatch):
    videos = tmp_path / "videos"
    monkeypatch.setattr(state, "VIDEOS_DIR", videos)
    vid = "0123456789ab"
    d = videos / vid
    d.mkdir(parents=True)
    (d / "meta.json").write_text(
        '{"name": "课", "source": "bilibili", "url": "https://bilibili.com/video/BV1xx",'
        ' "page": 2, "uploader": "UP", "duration": 12}',
        encoding="utf-8",
    )
    state.save_subtitles(vid, [Cue(1.0, 2.0, "你好")])
    state.save_summary(vid, "这是总结")

    items = state.export_library()
    assert len(items) == 1
    item = items[0]
    assert item["id"] == vid
    assert item["name"] == "课"
    assert item["page"] == 2
    assert item["uploader"] == "UP"
    assert item["cues"] == [{"start": 1.0, "end": 2.0, "text": "你好"}]
    assert item["summary"] == "这是总结"


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
