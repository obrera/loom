import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from '@workspace/db/schema'
import { loadConfig } from '@workspace/engine/config'
import { Orchestrator } from '@workspace/engine/orchestrator'
import { drizzle } from 'drizzle-orm/bun-sqlite'

async function main() {
  console.log('🔧 Loom Engine starting...')

  // Load config from env
  const config = loadConfig()
  console.log(`📡 Watching ${config.repos.length} repo(s)`)
  console.log(`🤖 Agent: ${config.agent.provider} (${config.agent.binary ?? config.agent.provider})`)

  // Initialize database
  const dbPath = process.env['DATABASE_URL'] ?? ':memory:'
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  const sqlite = new Database(dbPath)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')

  // Apply schema (create tables if not exist)
  applySchema(sqlite)

  const db = drizzle(sqlite, { schema })

  // Graceful shutdown
  const orchestrator = new Orchestrator(db, config)

  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...')
    orchestrator.stop()
    sqlite.close()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    orchestrator.stop()
    sqlite.close()
    process.exit(0)
  })

  // Start polling loop
  orchestrator.start()
}

function applySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      github_url TEXT NOT NULL,
      watch_label TEXT NOT NULL DEFAULT 'loom',
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE INDEX IF NOT EXISTS repos_owner_name_idx ON repos (owner, name);

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      github_issue_id INTEGER,
      repo_id INTEGER REFERENCES repos(id) ON DELETE SET NULL,
      pr_number INTEGER,
      pr_url TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE INDEX IF NOT EXISTS tasks_created_at_idx ON tasks (created_at);
    CREATE INDEX IF NOT EXISTS tasks_github_issue_id_idx ON tasks (github_issue_id);
    CREATE INDEX IF NOT EXISTS tasks_repo_id_idx ON tasks (repo_id);
    CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status);

    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    );

    CREATE INDEX IF NOT EXISTS task_logs_created_at_idx ON task_logs (created_at);
    CREATE INDEX IF NOT EXISTS task_logs_task_id_idx ON task_logs (task_id);

    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running',
      provider TEXT NOT NULL,
      model TEXT,
      started_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      completed_at TEXT,
      output TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs (status);
    CREATE INDEX IF NOT EXISTS agent_runs_task_id_idx ON agent_runs (task_id);
  `)
}

await main()
