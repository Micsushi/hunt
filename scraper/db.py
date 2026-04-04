import sqlite3
from config import DB_PATH, TITLE_BLACKLIST

def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row 
    return conn

def init_db():
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            company TEXT,
            location TEXT,
            job_url TEXT UNIQUE NOT NULL,
            apply_url TEXT,
            description TEXT,
            source TEXT,
            date_posted TEXT,
            is_remote BOOLEAN,
            status TEXT DEFAULT 'new',
            date_scraped TEXT DEFAULT CURRENT_TIMESTAMP,
            level TEXT,
            priority BOOLEAN DEFAULT 0,
            category TEXT
            )
        """)
        conn.commit()
    finally:
        conn.close()



def add_job(job_data):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR IGNORE INTO jobs (title, company, location, job_url, apply_url, description, source, date_posted, is_remote, level, priority, category)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (job_data['title'], job_data['company'], job_data['location'], job_data['job_url'], job_data['apply_url'], job_data['description'], job_data['source'], job_data['date_posted'], job_data['is_remote'], job_data['level'], job_data.get('priority', 0), job_data.get('category')))
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()

def get_all_jobs():
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM jobs")
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()

def get_job_by_id(job_id):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM jobs WHERE id = ?", (job_id,))
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()

def get_job_by_status(status):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM jobs WHERE status = ?", (status,))
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()

def get_jobs_grouped():
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT * FROM jobs
            ORDER BY company ASC, date_posted DESC
        """)
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()

def search_jobs(query):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        wildcard = f"%{query}%"
        cursor.execute("""
            SELECT * FROM jobs
            WHERE title LIKE ?
               OR company LIKE ?
               OR location LIKE ?
               OR description LIKE ?
        """, (wildcard, wildcard, wildcard, wildcard))
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def update_job_status(job_id, status):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("UPDATE jobs SET status = ? WHERE id = ?", (status, job_id))
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()

def remove_high_level_jobs():
    if not TITLE_BLACKLIST:
        return 0
    conn = get_connection()
    try:
        cursor = conn.cursor()
        patterns = [f"%{word}%".lower() for word in TITLE_BLACKLIST]
        placeholders = " OR ".join(["lower(title) LIKE ?"] * len(patterns))
        cursor.execute(f"DELETE FROM jobs WHERE {placeholders}", patterns)
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def clear_db():
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM jobs")
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()