const COVERAGE_CONSTRAINTS_MAPPING = Object.freeze({
  commercial_calendar: {
    table: null,
    commercial_column: null,
    date_column: null,
    available_column: null,
    working_days_column: null,
    source_label: null
  },
  commercial_absences: {
    table: null,
    commercial_column: null,
    date_column: null,
    absence_column: null,
    source_label: null
  },
  commercial_capacity: {
    table: null,
    commercial_column: null,
    date_column: null,
    hard_max_visits_column: null,
    max_load_units_column: null,
    source_label: null
  },
  commercial_shifts: {
    table: null,
    commercial_column: null,
    date_column: null,
    shift_start_time_column: null,
    shift_end_time_column: null,
    break_minutes_column: null,
    source_label: null
  },
  commercial_route_limits: {
    table: null,
    commercial_column: null,
    date_column: null,
    max_route_minutes_column: null,
    break_minutes_column: null,
    estimated_travel_minutes_column: null,
    source_label: null
  },
  client_service_duration: {
    table: null,
    client_id_column: null,
    service_minutes_column: null,
    commercial_column: null,
    date_column: null,
    estimated_stop_minutes_column: null,
    source_label: null
  },
  commercial_depots: {
    table: null,
    commercial_column: null,
    date_column: null,
    depot_id_column: null,
    depot_latitude_column: null,
    depot_longitude_column: null,
    source_label: null
  },
  client_restrictions: {
    table: 'clients',
    client_id_column: 'id',
    allowed_commercial_codes_column: 'user_code',
    denied_commercial_codes_column: null,
    deleted_at_column: 'deleted_at',
    active_column: 'isactif',
    active_value: '1',
    source_label: 'clients.user_code'
  }
})

module.exports = {
  COVERAGE_CONSTRAINTS_MAPPING
}
