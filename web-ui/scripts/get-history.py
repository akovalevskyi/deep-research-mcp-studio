import sqlite3
import json
import sys
import os

DB_PATH = "/app/data/research_history.db"

def main():
    if not os.path.exists(DB_PATH):
        print(json.dumps([]))
        return
        
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS research_runs (
                id TEXT PRIMARY KEY,
                query TEXT,
                timestamp INTEGER,
                summary TEXT,
                mindmap TEXT,
                podcast_script TEXT,
                audio_generated INTEGER,
                published_to_mattermost INTEGER,
                source TEXT
            )
        """)
        
        cursor.execute("SELECT id, query, timestamp, summary, mindmap, podcast_script, audio_generated, published_to_mattermost, source FROM research_runs ORDER BY timestamp DESC")
        rows = cursor.fetchall()
        runs = []
        for r in rows:
            runs.append({
                "id": r[0],
                "query": r[1],
                "timestamp": r[2],
                "summary": r[3],
                "mindmap": r[4],
                "podcastScript": r[5],
                "audioGenerated": bool(r[6]),
                "publishedToMattermost": bool(r[7]),
                "source": r[8]
            })
        print(json.dumps(runs))
    except Exception as e:
        print(json.dumps([]), file=sys.stderr)
        print(json.dumps([]))
    finally:
        conn.close()

if __name__ == "__main__":
    main()
