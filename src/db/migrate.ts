import fs from 'fs'
import path from 'path'
import pool from './client'

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  await pool.query(sql)
  console.log('✅ Database schema applied successfully')
  await pool.end()
}

migrate().catch((err: any) => {
  console.error('❌ Migration failed:', err.message || err)
  console.error('Stack:', err.stack)
  if (err.detail) console.error('Detail:', err.detail)
  if (err.code) console.error('Code:', err.code)
  process.exit(1)
})
