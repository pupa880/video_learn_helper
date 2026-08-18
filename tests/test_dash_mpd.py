"""DASH 直读：MPD 生成与请求头容错的单元测试（纯函数，无网络）。"""

import xml.etree.ElementTree as ET

from app.api.video import _build_mpd, _stream_headers


def _stream():
    return {
        "kind": "dash",
        "video_url": "https://example.com/v.m4s",
        "audio_url": "https://example.com/a.m4s",
        "headers": {"Referer": "https://www.bilibili.com"},
        "height": 700, "width": 1920, "fps": 30.0,
        "vbr": 526933, "abr": 125656, "asr": 48000,
        "vcodec": "avc1.640033", "acodec": "mp4a.40.2",
    }


def test_build_mpd_structure():
    xml = _build_mpd("vid123", {"duration": 5275.733}, _stream())
    root = ET.fromstring(xml)
    ns = "{urn:mpeg:dash:schema:mpd:2011}"
    assert root.tag == f"{ns}MPD"
    assert root.get("type") == "static"
    assert root.get("mediaPresentationDuration") == "PT5275.733S"
    reps = root.findall(f".//{ns}Representation")
    assert len(reps) == 2
    v, a = reps
    assert v.get("codecs") == "avc1.640033"
    assert v.get("width") == "1920" and v.get("height") == "700"
    assert v.get("frameRate") == "30"
    assert a.get("codecs") == "mp4a.40.2"
    assert a.get("audioSamplingRate") == "48000"
    urls = [b.text for b in root.findall(f".//{ns}BaseURL")]
    assert urls == ["/api/video/vid123/segment?track=video",
                    "/api/video/vid123/segment?track=audio"]


def test_build_mpd_missing_optional_fields():
    # 缺 width/fps/asr 等可选字段时仍是合法 XML，且不输出对应属性
    xml = _build_mpd("v", {"duration": 10},
                     {"kind": "dash", "video_url": "u", "audio_url": "u"})
    root = ET.fromstring(xml)
    ns = "{urn:mpeg:dash:schema:mpd:2011}"
    v = root.findall(f".//{ns}Representation")[0]
    assert v.get("width") is None and v.get("frameRate") is None
    assert v.get("bandwidth") == "1000000"  # 兜底码率


def test_stream_headers_dict_passthrough():
    h = _stream_headers({"headers": {"Referer": "https://www.bilibili.com"}})
    assert h == {"Referer": "https://www.bilibili.com"}


def test_stream_headers_legacy_repr_string():
    # 旧 meta 把 headers dict 存成了 repr 字符串，需容错解析
    h = _stream_headers({"headers": "{'Referer': 'https://www.bilibili.com'}"})
    assert h == {"Referer": "https://www.bilibili.com"}


def test_stream_headers_broken_string():
    assert _stream_headers({"headers": "not-a-dict"}) == {}
    assert _stream_headers({}) == {}
