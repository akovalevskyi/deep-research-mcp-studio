import sys
import json
import sqlite3
import os

DB_PATH = "/app/data/research_history.db"

def main():
    try:
        # Read JSON from stdin
        data = json.load(sys.stdin)
        
        # Ensure directories exist
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        
        # Initialize DB if not exists
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
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
        
        # Insert or replace row
        cursor.execute("""
            INSERT OR REPLACE INTO research_runs 
            (id, query, timestamp, summary, mindmap, podcast_script, audio_generated, published_to_mattermost, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            data['id'],
            data['query'],
            data['timestamp'],
            data['summary'],
            data['mindmap'],
            data['podcastScript'],
            1 if data.get('audioGenerated') else 0,
            1 if data.get('publishedToMattermost') else 0,
            data.get('source', 'mcp_cli')
        ))
        
        conn.commit()
        conn.close()
        print(f"Successfully saved research run {data['id']} to SQLite history!")
    except Exception as e:
        print(f"Error in insert-history.py: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
