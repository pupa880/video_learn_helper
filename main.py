"""入口：python main.py [--host 0.0.0.0] [--port 8000]"""

import argparse

import uvicorn


def main():
    parser = argparse.ArgumentParser(description="video_learn_helper")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run("app.server:app", host=args.host, port=args.port, reload=False)


if __name__ == "__main__":
    main()
