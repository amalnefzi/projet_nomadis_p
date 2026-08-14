const path = require('node:path')

const {
  __testables: serverTestables
} = require('../server')
const nextBestVisitService = require('../next_best_visit_service')
const {
  __testables: serviceTestables,
  runNextBestVisitProfileRebuildNow
} = nextBestVisitService

function parseArgs(argv = []) {
  return argv.reduce((result, arg) => {
    const [key, value] = String(arg || '').split('=', 2)
    if (key === '--historical-cutoff-date') {
      result.historicalCutoffDate = value || null
    }
    return result
  }, {
    historicalCutoffDate: null
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  try {
    const result = await runNextBestVisitProfileRebuildNow({
      queryAsync: serverTestables.queryAsync,
      withTransaction: serverTestables.withTransaction,
      querySalesHistoryRowsForClients: serviceTestables.querySalesHistoryRowsForClients,
      normalizeSalesHistoryRowsForClients: serviceTestables.normalizeSalesHistoryRowsForClients,
      queryVisitHistoryRowsForClients: serviceTestables.queryVisitHistoryRowsForClients,
      normalizeVisitHistoryRowsForClients: serviceTestables.normalizeVisitHistoryRowsForClients,
      historicalCutoffDate: args.historicalCutoffDate
    })

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
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
