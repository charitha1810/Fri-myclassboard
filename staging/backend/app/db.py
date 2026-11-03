"""SQL Server engine (pyodbc + ODBC Driver 18), built from the settings in backend/.env."""
from functools import lru_cache

from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL, Engine

from .config import get_settings


@lru_cache
def get_engine() -> Engine:
    s = get_settings()
    if not s.db_server:
        raise RuntimeError("MCB_DB_SERVER is not set in backend/.env")
    url = URL.create("mssql+pyodbc", query={"odbc_connect": s.odbc_connection_string()})
    return create_engine(url, pool_pre_ping=True, pool_recycle=1800, fast_executemany=True)


def ping() -> dict:
    """Cheap connectivity check: server version and the database the login lands in."""
    with get_engine().connect() as c:
        row = c.execute(text("SELECT @@VERSION AS version, DB_NAME() AS db, SUSER_SNAME() AS login")).mappings().first()
    return dict(row)
