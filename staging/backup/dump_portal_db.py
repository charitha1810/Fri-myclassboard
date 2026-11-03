"""Dump the portal PostgreSQL database named by MCB_APP_DB_URL in a backend/.env (pg_dump custom format).

usage: python dump_portal_db.py <env-file> <out-file>
Restore with:  pg_restore --no-owner -d <database> <out-file>
"""
import os
import subprocess
import sys

from sqlalchemy.engine import make_url

PG_DUMP = r"C:\Program Files\PostgreSQL\18\bin\pg_dump.exe"

env_file, out_file = sys.argv[1], sys.argv[2]
url = None
for line in open(env_file, encoding="utf-8"):
    if line.startswith("MCB_APP_DB_URL="):
        url = make_url(line.split("=", 1)[1].strip().strip("'\""))
if url is None:
    raise SystemExit("MCB_APP_DB_URL not found in " + env_file)

# The password goes through the environment so it never appears on a command line or in output.
result = subprocess.run(
    [PG_DUMP, "-h", url.host or "localhost", "-p", str(url.port or 5432), "-U", url.username,
     "-Fc", "-f", out_file, url.database],
    env=dict(os.environ, PGPASSWORD=url.password or ""), capture_output=True, text=True)
if result.returncode != 0:
    raise SystemExit("pg_dump failed: " + result.stderr.strip())
