const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildCoverageConstraintsDiagnosticResponse,
  loadCoverageConstraints,
  mergeCoverageCommercialConstraintEntries,
  resolveCoverageClientRestriction
} = require('../coverage_constraints_provider')

function createQueryAsync(dataset) {
  return async (sql, params = []) => {
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
      const tableName = params[1]
      return (dataset.schemas?.[tableName] || []).map(columnName => ({
        COLUMN_NAME: columnName
      }))
    }

    const tableMatch = sql.match(/FROM\s+`([^`]+)`/i)
    const tableName = tableMatch ? tableMatch[1] : null
    if (!tableName) {
      return []
    }

    return [...(dataset.rows?.[tableName] || [])]
  }
}

const SIMULATED_MAPPING = {
  commercial_calendar: {
    table: 'commercial_calendar',
    commercial_column: 'commercial_code',
    date_column: 'constraint_date',
    available_column: 'available_flag',
    working_days_column: 'working_days_csv',
    source_label: 'commercial_calendar.available_flag'
  },
  commercial_absences: {
    table: 'commercial_absences',
    commercial_column: 'commercial_code',
    date_column: 'constraint_date',
    absence_column: 'absence_flag',
    source_label: 'commercial_absences.absence_flag'
  },
  commercial_capacity: {
    table: 'commercial_capacity',
    commercial_column: 'commercial_code',
    date_column: 'constraint_date',
    hard_max_visits_column: 'hard_max_visits',
    max_load_units_column: 'max_load_units',
    source_label: 'commercial_capacity'
  },
  client_restrictions: {
    table: 'client_assignments',
    client_id_column: 'client_id',
    allowed_commercial_codes_column: 'allowed_commercial_code',
    denied_commercial_codes_column: 'denied_commercial_code',
    deleted_at_column: 'deleted_at',
    active_column: 'is_active',
    active_value: '1',
    source_label: 'client_assignments'
  }
}

test('DB availability constraints are merged without recreating unavailable slots', async () => {
  const queryAsync = createQueryAsync({
    schemas: {
      commercial_calendar: ['commercial_code', 'constraint_date', 'available_flag', 'working_days_csv'],
      commercial_absences: ['commercial_code', 'constraint_date', 'absence_flag'],
      commercial_capacity: ['commercial_code', 'constraint_date', 'hard_max_visits', 'max_load_units'],
      client_assignments: ['client_id', 'allowed_commercial_code', 'denied_commercial_code', 'deleted_at', 'is_active']
    },
    rows: {
      commercial_calendar: [
        {
          commercial_code: 'C001',
          constraint_date: '2026-08-03',
          availability_value: '1',
          available_flag: '1',
          working_days_value: '1,2,3',
          working_days_csv: '1,2,3'
        },
        {
          commercial_code: 'C001',
          constraint_date: '2026-08-04',
          availability_value: '0',
          available_flag: '0',
          working_days_value: '1,2,3',
          working_days_csv: '1,2,3'
        }
      ],
      commercial_absences: [],
      commercial_capacity: [],
      client_assignments: []
    }
  })

  const constraints = await loadCoverageConstraints({
    startDate: '2026-08-03',
    endDate: '2026-08-04',
    commercialCodes: ['C001'],
    clientIds: []
  }, {
    queryAsync,
    database: 'dist_utic_test',
    mapping: SIMULATED_MAPPING
  })

  const merged = mergeCoverageCommercialConstraintEntries(
    constraints.commercials.C001,
    {
      available_dates: ['2026-08-03', '2026-08-04'],
      unavailable_dates: ['2026-08-05']
    }
  )

  assert.deepEqual(merged.working_days, [1, 2, 3])
  assert.deepEqual(merged.available_dates, ['2026-08-03'])
  assert.deepEqual(merged.unavailable_dates, ['2026-08-04', '2026-08-05'])
  assert.equal(constraints.diagnostic.availability_loaded, true)
})

test('DB hard max visits and truck capacity override request preferences', async () => {
  const queryAsync = createQueryAsync({
    schemas: {
      commercial_calendar: [],
      commercial_absences: [],
      commercial_capacity: ['commercial_code', 'constraint_date', 'hard_max_visits', 'max_load_units'],
      client_assignments: []
    },
    rows: {
      commercial_capacity: [
        {
          commercial_code: 'C001',
          constraint_date: '2026-08-03',
          hard_max_visits_value: 30,
          hard_max_visits: 30,
          max_load_units_value: 12.5,
          max_load_units: 12.5
        }
      ]
    }
  })

  const constraints = await loadCoverageConstraints({
    startDate: '2026-08-03',
    endDate: '2026-08-03',
    commercialCodes: ['C001'],
    clientIds: []
  }, {
    queryAsync,
    database: 'dist_utic_test',
    mapping: SIMULATED_MAPPING
  })

  const merged = mergeCoverageCommercialConstraintEntries(
    constraints.commercials.C001,
    {
      hard_max_visits_by_date: {
        '2026-08-03': 60
      },
      max_load_units_by_date: {
        '2026-08-03': 40
      }
    }
  )

  assert.equal(merged.hard_max_visits_by_date['2026-08-03'], 30)
  assert.equal(merged.max_load_units_by_date['2026-08-03'], 12.5)
  assert.equal(constraints.diagnostic.hard_visits_loaded, true)
  assert.equal(constraints.diagnostic.truck_capacity_loaded, true)
})

test('client-commercial restrictions stay keyed by client_id and keep distinct identities', async () => {
  const queryAsync = createQueryAsync({
    schemas: {
      commercial_calendar: [],
      commercial_absences: [],
      commercial_capacity: [],
      client_assignments: ['client_id', 'allowed_commercial_code', 'denied_commercial_code', 'deleted_at', 'is_active']
    },
    rows: {
      client_assignments: [
        {
          client_id: '1408',
          allowed_commercial_code: 'C001',
          denied_commercial_code: '',
          deleted_at: null,
          is_active: '1'
        },
        {
          client_id: '1410',
          allowed_commercial_code: 'C002',
          denied_commercial_code: '',
          deleted_at: null,
          is_active: '1'
        }
      ]
    }
  })

  const constraints = await loadCoverageConstraints({
    startDate: '2026-08-03',
    endDate: '2026-08-03',
    commercialCodes: ['C001', 'C002'],
    clientIds: ['1408', '1410']
  }, {
    queryAsync,
    database: 'dist_utic_test',
    mapping: SIMULATED_MAPPING
  })

  assert.deepEqual(
    constraints.client_restrictions['1408'].allowed_commercial_codes,
    ['C001']
  )
  assert.deepEqual(
    constraints.client_restrictions['1410'].allowed_commercial_codes,
    ['C002']
  )
  assert.notDeepEqual(
    constraints.client_restrictions['1408'].allowed_commercial_codes,
    constraints.client_restrictions['1410'].allowed_commercial_codes
  )

  const resolved = resolveCoverageClientRestriction({
    clientId: '1408',
    constraintEntry: constraints.client_restrictions['1408'],
    historicalCommercialCode: 'C002',
    activeCommercialCodes: ['C001', 'C002'],
    allowCommercialReassignment: true
  })
  assert.deepEqual(resolved.allowed_commercial_codes, ['C001'])
})

test('missing DB sources stay unknown and do not invent physical capacities', async () => {
  const constraints = await loadCoverageConstraints({
    startDate: '2026-08-03',
    endDate: '2026-08-10',
    commercialCodes: ['C001'],
    clientIds: ['1408']
  }, {
    queryAsync: createQueryAsync({ schemas: {}, rows: {} }),
    database: 'dist_utic_test',
    mapping: {
      commercial_calendar: { table: null },
      commercial_absences: { table: null },
      commercial_capacity: { table: null },
      client_restrictions: { table: null }
    }
  })

  assert.equal(constraints.diagnostic.availability_loaded, false)
  assert.equal(constraints.diagnostic.absences_loaded, false)
  assert.equal(constraints.diagnostic.hard_visits_loaded, false)
  assert.equal(constraints.diagnostic.truck_capacity_loaded, false)
  assert.deepEqual(constraints.commercials.C001.hard_max_visits_by_date, {})
  assert.deepEqual(constraints.commercials.C001.max_load_units_by_date, {})

  const diagnostic = buildCoverageConstraintsDiagnosticResponse(constraints, {
    startDate: '2026-08-03',
    endDate: '2026-08-10',
    commercialsChecked: 1,
    clientsChecked: 1
  })

  assert.equal(diagnostic.operational_capacity_known, false)
  assert.equal(diagnostic.time_capacity_known, false)
  assert.equal(diagnostic.constraints.hard_max_visits.status, 'absent')
  assert.equal(diagnostic.constraints.truck_capacity.status, 'absent')
  assert.equal(diagnostic.constraints.route_time.status, 'absent')
})

test('shift and route-limit mappings compute net route minutes without inventing time capacity', async () => {
  const queryAsync = createQueryAsync({
    schemas: {
      commercial_shifts: ['commercial_code', 'constraint_date', 'shift_start_time', 'shift_end_time', 'break_minutes'],
      commercial_route_limits: ['commercial_code', 'constraint_date', 'max_route_minutes', 'break_minutes'],
      client_service_durations: ['client_id', 'service_minutes', 'commercial_code', 'constraint_date', 'estimated_stop_minutes']
    },
    rows: {
      commercial_shifts: [
        {
          commercial_code: 'C001',
          constraint_date: '2026-08-03',
          shift_start_time_value: '08:00',
          shift_start_time: '08:00',
          shift_end_time_value: '17:00',
          shift_end_time: '17:00',
          break_minutes_value: 60,
          break_minutes: 60
        }
      ],
      commercial_route_limits: [
        {
          commercial_code: 'C001',
          constraint_date: '2026-08-03',
          max_route_minutes_value: 500,
          max_route_minutes: 500,
          break_minutes_value: 60,
          break_minutes: 60
        }
      ],
      client_service_durations: [
        {
          client_id: '1408',
          service_minutes_value: 20,
          service_minutes: 20,
          commercial_code_value: 'C001',
          commercial_code: 'C001',
          constraint_date: '2026-08-03',
          estimated_stop_minutes_value: 23,
          estimated_stop_minutes: 23
        }
      ]
    }
  })

  const constraints = await loadCoverageConstraints({
    startDate: '2026-08-03',
    endDate: '2026-08-03',
    commercialCodes: ['C001'],
    clientIds: ['1408']
  }, {
    queryAsync,
    database: 'dist_utic_test',
    mapping: {
      ...SIMULATED_MAPPING,
      commercial_shifts: {
        table: 'commercial_shifts',
        commercial_column: 'commercial_code',
        date_column: 'constraint_date',
        shift_start_time_column: 'shift_start_time',
        shift_end_time_column: 'shift_end_time',
        break_minutes_column: 'break_minutes',
        source_label: 'commercial_shifts'
      },
      commercial_route_limits: {
        table: 'commercial_route_limits',
        commercial_column: 'commercial_code',
        date_column: 'constraint_date',
        max_route_minutes_column: 'max_route_minutes',
        break_minutes_column: 'break_minutes',
        source_label: 'commercial_route_limits'
      },
      client_service_duration: {
        table: 'client_service_durations',
        client_id_column: 'client_id',
        service_minutes_column: 'service_minutes',
        commercial_column: 'commercial_code',
        date_column: 'constraint_date',
        estimated_stop_minutes_column: 'estimated_stop_minutes',
        source_label: 'client_service_durations'
      },
      commercial_depots: { table: null }
    }
  })

  assert.equal(constraints.commercials.C001.max_route_minutes_by_date['2026-08-03'], 480)
  assert.equal(constraints.client_restrictions['1408'].service_minutes, 20)
  assert.equal(
    constraints.client_restrictions['1408'].estimated_stop_minutes_by_commercial_date['2026-08-03::C001'],
    23
  )
  assert.equal(constraints.diagnostic.time_capacity_known, true)

  const diagnostic = buildCoverageConstraintsDiagnosticResponse(constraints, {
    startDate: '2026-08-03',
    endDate: '2026-08-03',
    commercialsChecked: 1,
    clientsChecked: 1
  })
  assert.equal(diagnostic.constraints.route_time.status, 'complete')
  assert.equal(diagnostic.constraints.route_time.commercials_with_shift_data, 1)
  assert.equal(diagnostic.constraints.route_time.commercials_with_route_limit, 1)
  assert.equal(diagnostic.constraints.route_time.clients_with_service_duration, 1)
})
