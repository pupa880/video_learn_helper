"""配置加载不得改写 DEFAULT_CONFIG。"""

from app import config as app_config
from app import state


def test_load_config_does_not_mutate_defaults(tmp_path, monkeypatch):
    monkeypatch.setattr(app_config, "CONFIG_PATH", tmp_path / "missing.json")
    app_config._config = None
    before = app_config.DEFAULT_CONFIG["llm"]["provider"]
    cfg = app_config.load_config()
    cfg["llm"]["provider"] = "__mutated__"
    assert app_config.DEFAULT_CONFIG["llm"]["provider"] == before
    app_config._config = None


def test_cookies_path_ignores_empty(tmp_path, monkeypatch):
    p = tmp_path / "cookies.txt"
    monkeypatch.setattr(app_config, "COOKIES_PATH", p)
    assert app_config.cookies_path() is None
    p.write_text("")
    assert app_config.cookies_path() is None
    p.write_text("# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\tx\n")
    assert app_config.cookies_path() == str(p)


def test_public_config_includes_asr_model_cached(tmp_path, monkeypatch):
    monkeypatch.setattr(app_config, "CONFIG_PATH", tmp_path / "missing.json")
    monkeypatch.setattr(app_config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(app_config, "COOKIES_PATH", tmp_path / "cookies.txt")
    app_config._config = None
    pub = app_config.public_config()
    assert "asr_model_cached" in pub
    assert pub["asr"]["model"] == "sensevoice"
    assert pub["bilibili"]["cookies_uploaded"] is False


def test_invalid_video_id_rejected():
    try:
        state.video_dir("../etc")
        assert False, "should reject path traversal"
    except state.InvalidVideoId:
        pass
    try:
        state.load_meta("not-a-hex-id")
        assert False, "should reject non-hex id"
    except state.InvalidVideoId:
        pass
