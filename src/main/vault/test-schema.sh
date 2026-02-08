#!/bin/bash
set -e

DB_FILE="test_schema.db"
SCHEMA_FILE="src/main/vault/schema.sql"

rm -f "$DB_FILE"

# 1. Initialize DB with schema
# We need to ensure foreign_keys is ON for the connection
sqlite3 "$DB_FILE" "PRAGMA foreign_keys = ON;" ".read $SCHEMA_FILE"

# 2. Check Tables
echo "Checking tables..."
TABLES=$(sqlite3 "$DB_FILE" "SELECT name FROM sqlite_master WHERE type='table' OR type='virtual table';")
EXPECTED="documents document_sources chunks chunks_fts ingestion_jobs action_plans actions"

for TABLE in $EXPECTED; do
    if echo "$TABLES" | grep -q "$TABLE"; then
        echo "✅ Table $TABLE exists"
    else
        echo "❌ Table $TABLE missing"
        exit 1
    fi
done

# 3. Test Foreign Key Enforcement
echo "Testing Foreign Keys..."
OUTPUT=$(sqlite3 "$DB_FILE" "PRAGMA foreign_keys = ON; INSERT INTO document_sources (source_uri, document_id) VALUES ('file:///test', 'missing-id');" 2>&1 || true)
if echo "$OUTPUT" | grep -q "FOREIGN KEY constraint failed"; then
    echo "✅ Foreign Key constraint enforced (caught expected error)"
else 
    echo "❌ Foreign Key constraint seemingly NOT enforced. Output: $OUTPUT"
    exit 1
fi

# 4. Test FTS trigger
echo "Testing FTS Triggers..."
sqlite3 "$DB_FILE" <<EOF
PRAGMA foreign_keys = ON;
INSERT INTO documents (id, hash, mime_type, size_bytes) VALUES ('d1', 'h1', 'text', 10);
INSERT INTO chunks (chunk_rowid, id, document_id, content, content_hash, chunk_index, start_char_offset, end_char_offset) 
VALUES (1, 'c1', 'd1', 'hello world', 'ch1', 0, 0, 11);
EOF

SEARCH_RESULT=$(sqlite3 "$DB_FILE" "SELECT content FROM chunks_fts WHERE chunks_fts MATCH 'hello';")
if [ "$SEARCH_RESULT" == "hello world" ]; then
    echo "✅ FTS Search successful"
else
    echo "❌ FTS Search failed. Result: '$SEARCH_RESULT'"
    exit 1
fi

# Cleanup
rm -f "$DB_FILE"
echo "🎉 Schema validation passed!"
