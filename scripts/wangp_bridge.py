from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def emit(value):
    print("CINEFORGE_JSON:" + json.dumps(value, ensure_ascii=False, default=str))


def create_session(root: Path, profile: int, attention: str):
    sys.path.insert(0, str(root))
    os.chdir(root)
    from shared.api import init

    cli_args = ["--profile", str(profile)]
    if attention and attention != "auto":
        cli_args += ["--attention", attention]
    return init(root=root, cli_args=cli_args)


def compact(entry):
    metadata = entry.get("metadata") or {}
    return {
        "modelType": entry.get("model_type") or metadata.get("model_type"),
        "name": entry.get("name") or metadata.get("name") or entry.get("model_type"),
        "family": metadata.get("family"),
        "familyLabel": metadata.get("family_label"),
        "mainOutput": metadata.get("main_output") or [],
        "outputs": metadata.get("outputs") or [],
        "inputs": metadata.get("inputs") or [],
        "description": entry.get("description") or metadata.get("description") or "",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["catalog", "template", "doctor"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--profile", type=int, default=4)
    parser.add_argument("--attention", default="auto")
    parser.add_argument("--model-type")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    if not (root / "wgp.py").exists():
        raise SystemExit(f"WanGP root is invalid: {root}")

    if args.command == "doctor":
        info = {"python": sys.version.split()[0], "executable": sys.executable}
        try:
            import torch
            info.update({
                "torch": torch.__version__,
                "torchCuda": torch.version.cuda,
                "cudaAvailable": torch.cuda.is_available(),
                "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
            })
        except Exception as exc:
            info["torchError"] = str(exc)
        emit(info)
        return

    session = create_session(root, args.profile, args.attention)

    if args.command == "catalog":
        entries = session.list_model_metadata(main_output=["image", "video"])
        emit([compact(entry) for entry in entries])
        return

    if not args.model_type:
        raise SystemExit("--model-type is required for template")
    settings = session.get_default_settings(args.model_type)
    if not isinstance(settings, dict):
        raise SystemExit(f"WanGP returned no default settings for {args.model_type}")
    settings = dict(settings)
    settings["model_type"] = args.model_type
    emit(settings)


if __name__ == "__main__":
    main()
