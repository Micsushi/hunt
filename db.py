import sqlite3

DB_PATH = "hunt.db"

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
            priority BOOLEAN DEFAULT 0
            )
        """)
        conn.commit()
    finally:
        conn.close()



def job_exists(job_data):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT date_posted FROM jobs
            WHERE company = ? AND title = ?
            ORDER BY date_posted DESC
            LIMIT 1
            """, (job_data['company'], job_data['title']))
        row = cursor.fetchone()
        if row is None:
            return False

        existing_date = row["date_posted"]
        new_date = job_data.get("date_posted")
        if not existing_date or not new_date or existing_date == "None" or new_date == "None":
            return True

        from datetime import datetime, timedelta
        try:
            existing_dt = datetime.strptime(existing_date[:10], "%Y-%m-%d")
            new_dt = datetime.strptime(new_date[:10], "%Y-%m-%d")
            return abs((new_dt - existing_dt).days) < 7
        except ValueError:
            return True
    finally:
        conn.close()

def add_job(job_data):
    if not job_data.get('priority') and job_exists(job_data):
        return None

    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR IGNORE INTO jobs (title, company, location, job_url, apply_url, description, source, date_posted, is_remote, level, priority)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (job_data['title'], job_data['company'], job_data['location'], job_data['job_url'], job_data['apply_url'], job_data['description'], job_data['source'], job_data['date_posted'], job_data['is_remote'], job_data['level'], job_data.get('priority', 0)))
        conn.commit()
        return cursor.lastrowid
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

def get_job_by_id(id):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM jobs WHERE id = ?", (id,))
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


def update_job_status(id, status):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("UPDATE jobs SET status = ? WHERE id = ?", (status, id))
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