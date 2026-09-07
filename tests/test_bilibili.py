"""B站链接分P 参数处理（纯函数，不访问网络）。"""

from app.services.bilibili import (
    classify_subtitle_error,
    page_from_url,
    upload_date_of,
    with_page,
)


def test_page_from_url():
    assert page_from_url("https://www.bilibili.com/video/BV1xx") == 1
    assert page_from_url("https://www.bilibili.com/video/BV1xx?p=3") == 3
    assert page_from_url("https://www.bilibili.com/video/BV1xx?spm=1&p=12") == 12


def test_with_page_noop_when_page_le_1():
    url = "https://www.bilibili.com/video/BV1xx?p=3"
    # page<=1 不得剥掉已有 p=（下载复用 meta.url 时默认 page=1）
    assert with_page(url, 1) == url
    assert with_page("https://www.bilibili.com/video/BV1xx", 1) == (
        "https://www.bilibili.com/video/BV1xx"
    )


def test_with_page_replaces_existing():
    url = "https://www.bilibili.com/video/BV1xx?p=2&spm_id_from=333"
    out = with_page(url, 5)
    assert "p=5" in out
    assert "p=2" not in out
    assert "spm_id_from=333" in out


def test_upload_date_of():
    assert upload_date_of({"upload_date": "20260315"}) == "2026-03-15"
    assert upload_date_of({"timestamp": 1_710_460_800}) == "2024-03-15"
    assert upload_date_of({}) == ""
    assert upload_date_of({"upload_date": "bad"}) == ""


def test_with_page_appends():
    assert with_page("https://www.bilibili.com/video/BV1xx", 2).endswith("?p=2")
    assert "p=2" in with_page("https://www.bilibili.com/video/BV1xx?t=1", 2)


def test_classify_subtitle_error_wind_control():
    msg = classify_subtitle_error("HTTP Error 412: Precondition Failed", has_cookies=True)
    assert "风控" in msg
    assert "cookies" not in msg.lower() or "请稍后再试" in msg
    no_cookie = classify_subtitle_error("-412 请求被拦截", has_cookies=False)
    assert "风控" in no_cookie
    assert "cookies" in no_cookie.lower()


def test_classify_subtitle_error_missing_cookies():
    msg = classify_subtitle_error("字幕内容为空", has_cookies=False)
    assert "未上传" in msg
    assert "cookies" in msg.lower()


def test_classify_subtitle_error_invalid_cookies():
    msg = classify_subtitle_error("-101 账号未登录", has_cookies=True)
    assert "无效" in msg or "过期" in msg
    unknown = classify_subtitle_error("connection reset", has_cookies=True)
    assert "connection reset" in unknown
