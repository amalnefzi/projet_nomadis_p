const {
  runAllValidationScenarios
} = require('../next_best_visit_validation_lab')

async function main() {
  const report = await runAllValidationScenarios()

  report.scenarios.forEach(result => {
    process.stdout.write(`Scenario: ${result.scenario_id}\n`)
    process.stdout.write(`Status: ${result.status}\n`)
    process.stdout.write(`Runtime: ${result.runtime_ms} ms\n`)
    process.stdout.write(`Opportunities: ${result.opportunities_count}\n`)
    process.stdout.write(`Selected visits: ${result.selected_visits_count}\n`)
    if (result.failures.length) {
      process.stdout.write('Failed assertion(s):\n')
      result.failures.forEach(failure => {
        process.stdout.write(`- ${failure}\n`)
      })
    }
    process.stdout.write('\n')
  })

  process.stdout.write('Benchmarks:\n')
  report.benchmarks.forEach(benchmark => {
    process.stdout.write(
      `- ${benchmark.client_count} clients / ${benchmark.planning_horizon_days} jours: ${benchmark.runtime_ms} ms ` +
      `(target ${benchmark.target_ms} ms, sparsity ${benchmark.sparsity_ratio}%)\n`
    )
  })
  process.stdout.write('\n')

  process.stdout.write('Global:\n')
  process.stdout.write(`- total: ${report.summary.total}\n`)
  process.stdout.write(`- passed: ${report.summary.passed}\n`)
  process.stdout.write(`- failed: ${report.summary.failed}\n`)
  process.stdout.write(`- critical failures: ${report.summary.critical_failures}\n`)
  process.stdout.write(`- deterministic: ${report.summary.deterministic}\n`)
  process.stdout.write(`- total runtime: ${report.summary.total_runtime_ms} ms\n`)
  process.stdout.write(`- technical_validation_status: ${report.statuses.technical_validation_status}\n`)
  process.stdout.write(`- logical_validation_status: ${report.statuses.logical_validation_status}\n`)
  process.stdout.write(`- commercial_validation_status: ${report.statuses.commercial_validation_status}\n`)

  process.exit(report.summary.critical_failures > 0 ? 1 : 0)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
