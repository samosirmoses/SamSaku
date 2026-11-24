"""Encrypted PostgreSQL dump/restore using libpq environment settings and GnuPG."""
import argparse
import getpass
import os
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("save", "restore"))
    parser.add_argument("archive", type=Path)
    parser.add_argument("--passphrase-stdin", action="store_true",
                        help="Read a single passphrase from a private pipe for automated backups.")
    args = parser.parse_args()
    if not os.environ.get("PGDATABASE"):
        parser.error("Set PGDATABASE, PGHOST, PGUSER and an authenticated libpq connection first.")
    archive = args.archive.resolve()
    if args.action == "save" and archive.exists():
        parser.error("Choose a new archive path.")
    if args.action == "restore" and not archive.is_file():
        parser.error("Archive does not exist.")
    phrase = sys.stdin.readline().rstrip("\r\n") if args.passphrase_stdin else getpass.getpass("Passphrase cadangan: ")
    if not phrase:
        parser.error("Passphrase required.")
    if args.action == "save" and not args.passphrase_stdin and phrase != getpass.getpass("Konfirmasi passphrase: "):
        parser.error("Passphrases differ.")
    secret = (phrase + "\n").encode()
    gpg = ["gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase-fd", "0"]
    with TemporaryDirectory() as temp:
        dump = Path(temp) / "ledger.dump"
        if args.action == "save":
            subprocess.run(["pg_dump", "--format=custom", "--no-owner", "--no-privileges",
                            "--schema=public", "--file", str(dump)], check=True)
            # First encrypt in the archive directory; publish only a complete file.
            with TemporaryDirectory(dir=archive.parent) as destination:
                encrypted = Path(destination) / "archive.gpg"
                subprocess.run(gpg + ["--symmetric", "--cipher-algo", "AES256",
                               "--output", str(encrypted), str(dump)], input=secret, check=True)
                os.link(encrypted, archive)
        else:
            query = "select count(*) from pg_catalog.pg_tables where schemaname='public'"
            result = subprocess.check_output(["psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-c", query], text=True)
            if result.strip() != "0":
                parser.error("Restore is supported only into an empty public schema.")
            subprocess.run(gpg + ["--decrypt", "--output", str(dump), str(archive)], input=secret, check=True)
            # A fresh DB already has a public schema. Exclude that TOC item only.
            toc = subprocess.check_output(["pg_restore", "--list", str(dump)], text=True)
            toc_path = Path(temp) / "restore.list"
            toc_path.write_text("\n".join(line for line in toc.splitlines() if " SCHEMA - public " not in line), encoding="utf-8")
            subprocess.run(["pg_restore", "--use-list", str(toc_path), "--single-transaction", "--exit-on-error",
                            "--no-owner", "--no-privileges", "--dbname", os.environ["PGDATABASE"], str(dump)], check=True)
    print("Cadangan selesai." if args.action == "save" else "Pemulihan selesai.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.CalledProcessError) as exc:
        sys.exit(f"Operasi gagal ({type(exc).__name__}).")
