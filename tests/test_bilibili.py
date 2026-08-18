"""B站链接分P 参数处理（纯函数，不访问网络）。"""

from app.services.bilibili import page_from_url, with_page


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


def test_with_page_appends():
    assert with_page("https://www.bilibili.com/video/BV1xx", 2).endswith("?p=2")
    assert "p=2" in with_page("https://www.bilibili.com/video/BV1xx?t=1", 2)
