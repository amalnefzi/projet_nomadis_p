const {
  __testables: serverTestables
} = require('../server')
const {
  PREDICTION_CACHE_TABLE
} = require('../next_best_visit_prediction_cache_store')

async function main() {
  try {
    await serverTestables.queryAsync(`TRUNCATE TABLE ${PREDICTION_CACHE_TABLE}`)
    process.stdout.write(`${JSON.stringify({
      status: 'success',
      table: PREDICTION_CACHE_TABLE
    }, null, 2)}\n`)
  } finally {
    if (typeof serverTestables.closeOpenHandles === 'function') {
      await serverTestables.closeOpenHandles()
    }
  }
}

main().catch(error => {
  process.stderr.write(`${error.message || String(error)}\n`)
  process.exitCode = 1
})
