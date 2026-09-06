const test = require('node:test')
const assert = require('node:assert/strict')

const {
  allocateRecoveryPayments,
  buildRecoveryNonCancelledDocumentSqlCondition,
  buildRecoveryPlanRowsFromProfiles,
  buildValidRecoveryPaymentSqlCondition,
  classifyRecoveryProfilesForPeriod,
  loadRecoveryProfiles
} = require('../coverage_recovery_profiles')

// Le mock accepte les données au format historique (creditRows: credit_date/doc_solde,
// paymentRows: payment_amount) et les traduit vers le nouveau schéma de requêtes
// (documents = net_a_payer ; paiements = montant/credit/code_bl/échéances).
function createQueryRowsMock({
  creditRows = [],
  documentRows = null,
  paymentRows = [],
  inspectSql = null
} = {}) {
  return async (sql, params = []) => {
    if (typeof inspectSql === 'function') {
      inspectSql(sql, params)
    }

    if (sql.includes('FROM entetecommercials e')) {
      const source = Array.isArray(documentRows) ? documentRows : creditRows
      return source.map((row, index) => ({
        client_code: row.client_code,
        doc_code: row.doc_code ?? `DOC-${row.client_code}-${index}`,
        doc_type: (row.doc_type ?? 'bl').toLowerCase(),
        doc_date: row.doc_date ?? row.credit_date ?? null,
        doc_commercial_code: row.doc_commercial_code ?? null,
        doc_net_a_payer: row.doc_net_a_payer ?? row.net_a_payer ?? row.doc_credit_amount ?? row.doc_solde ?? 0
      }))
    }
    if (sql.includes('FROM paiements p')) {
      return paymentRows.map(row => ({
        payment_id: row.payment_id ?? null,
        client_code: row.client_code,
        payment_date: row.payment_date ?? null,
        payment_montant: row.payment_montant ?? row.payment_amount ?? 0,
        payment_credit: row.payment_credit ?? 0,
        payment_code_bl: row.payment_code_bl ?? null,
        echeance_credit: row.echeance_credit ?? null,
        echeance_traite: row.echeance_traite ?? null,
        echeance_cheque: row.echeance_cheque ?? null,
        codeAnnulation: row.codeAnnulation ?? null,
        recouvrement: row.recouvrement ?? null,
        impaye: row.impaye ?? 0
      }))
    }

    throw new Error(`Unexpected SQL in test mock: ${sql.slice(0, 80)}`)
  }
}

function createRecoveryProfile(overrides = {}) {
  const clientId = overrides.client_id ?? 'client-1'
  const clientCode = overrides.client_code ?? 'C-001'
  return {
    client_id: clientId,
    client_code: clientCode,
    credit: {
      total_balance: 100,
      due_amount: 0,
      ...(overrides.credit || {})
    },
    payment_behavior: {
      expected_next_payment_date: null,
      ...(overrides.payment_behavior || {})
    },
    diagnostics: {
      historical_code_status: 'matched',
      ...(overrides.diagnostics || {})
    },
    ...overrides
  }
}

test('distinct client ids keep exact historical codes 00152 and 152 separate', async () => {
  const profiles = await loadRecoveryProfiles({
    clientIds: ['1', '2'],
    referenceDate: '2026-07-31',
    clientRows: [
      { client_id: '1', nbr_client: '00152', plafond: 1000, delai_paiement: 30 },
      { client_id: '2', nbr_client: '152', plafond: 1000, delai_paiement: 30 }
    ],
    queryRows: createQueryRowsMock({
      creditRows: [
        { client_code: '00152', credit_date: '2026-06-01', doc_solde: 100, doc_credit_amount: 100 },
        { client_code: '152', credit_date: '2026-06-02', doc_solde: 200, doc_credit_amount: 200 }
      ],
      paymentRows: [
        { payment_id: 'p1', client_code: '00152', payment_date: '2026-06-15', payment_amount: 40, payment_ref: 'A' },
        { payment_id: 'p2', client_code: '152', payment_date: '2026-06-16', payment_amount: 90, payment_ref: 'B' }
      ]
    })
  })

  const byId = new Map(profiles.map(profile => [profile.client_id, profile]))
  assert.equal(byId.get('1').client_code, '00152')
  assert.equal(byId.get('2').client_code, '152')
  // net_a_payer 100 / 200 moins le paiement encaissé 40 / 90 (imputé FIFO)
  assert.equal(byId.get('1').credit.total_balance, 60)
  assert.equal(byId.get('2').credit.total_balance, 110)
  assert.equal(byId.get('1').payment_behavior.total_paid_history, 40)
  assert.equal(byId.get('2').payment_behavior.total_paid_history, 90)
})

test('javascript Date credit rows keep overdue debt and earliest due date without timezone drift', async () => {
  const [profile] = await loadRecoveryProfiles({
    clientIds: ['3330'],
    referenceDate: '2026-08-30',
    clientRows: [
      { client_id: '3330', nbr_client: '00003330', plafond: 20000, delai_paiement: 0 }
    ],
    queryRows: createQueryRowsMock({
      creditRows: [
        {
          client_code: '00003330',
          credit_date: new Date('2026-06-01'),
          doc_solde: 14565.052,
          doc_credit_amount: 14565.052
        }
      ]
    })
  })

  assert.equal(profile.credit.oldest_credit_date, '2026-06-01')
  assert.equal(profile.credit.last_credit_date, '2026-06-01')
  assert.equal(profile.credit.due_amount > 0, true)
  assert.equal(profile.credit.days_past_due > 0, true)
})

test('cancelled credit documents are excluded by the SQL filter and do not change balances', async () => {
  const capturedSql = []
  const profiles = await loadRecoveryProfiles({
    clientIds: ['10'],
    referenceDate: '2026-07-31',
    clientRows: [
      { client_id: '10', nbr_client: '00190', plafond: 1000, delai_paiement: 7 }
    ],
    queryRows: createQueryRowsMock({
      creditRows: [
        { client_code: '00190', credit_date: '2026-06-01', doc_solde: 120, doc_credit_amount: 120 }
      ],
      inspectSql: sql => {
        capturedSql.push(sql)
      }
    })
  })

  const creditSql = capturedSql.find(sql => sql.includes('doc_net_a_payer'))
  assert.ok(creditSql)
  assert.match(creditSql, /e\.annule IS NULL/)
  assert.match(creditSql, /TRIM\(e\.annule\) = ''/)
  assert.match(creditSql, /TRIM\(e\.annule\) = '0'/)
  assert.equal(buildRecoveryNonCancelledDocumentSqlCondition('e.annule'), "(e.annule IS NULL OR TRIM(e.annule) = '' OR TRIM(e.annule) = '0')")
  assert.equal(profiles[0].credit.total_balance, 120)
  assert.equal(profiles[0].credit.due_amount, 120)
})

test('invalid payments are excluded by the SQL filter and do not change payment statistics', async () => {
  const capturedSql = []
  const profiles = await loadRecoveryProfiles({
    clientIds: ['11'],
    referenceDate: '2026-07-31',
    clientRows: [
      { client_id: '11', nbr_client: '00217', plafond: 1000, delai_paiement: 7 }
    ],
    queryRows: createQueryRowsMock({
      creditRows: [
        { client_code: '00217', credit_date: '2026-06-01', doc_solde: 300, doc_credit_amount: 300 }
      ],
      paymentRows: [
        { payment_id: 'p-valid', client_code: '00217', payment_date: '2026-06-10', payment_amount: 100, payment_ref: 'R1' }
      ],
      inspectSql: sql => {
        capturedSql.push(sql)
      }
    })
  })

  const paymentSql = capturedSql.find(sql => sql.includes('FROM paiements p'))
  assert.ok(paymentSql)
  assert.match(paymentSql, /CAST\(COALESCE\(p\.montant, '0'\) AS DECIMAL\(15,3\)\) > 0/)
  assert.match(paymentSql, /p\.codeAnnulation IS NULL/)
  assert.doesNotMatch(buildValidRecoveryPaymentSqlCondition('p'), /impaye/)
  assert.doesNotMatch(buildValidRecoveryPaymentSqlCondition('p'), /recouvrement/)
  assert.equal(profiles[0].payment_behavior.average_payment_amount, 100)
  assert.equal(profiles[0].payment_behavior.median_payment_amount, 100)
  assert.equal(profiles[0].recovery.expected_collection_amount > 0, true)
})

test('usual payment amount computes average and median from valid payments', async () => {
  const [profile] = await loadRecoveryProfiles({
    clientIds: ['12'],
    referenceDate: '2026-07-31',
    clientRows: [
      { client_id: '12', nbr_client: '00300', plafond: 1000, delai_paiement: 15 }
    ],
    queryRows: createQueryRowsMock({
      creditRows: [
        { client_code: '00300', credit_date: '2026-05-01', doc_solde: 600, doc_credit_amount: 600 }
      ],
      paymentRows: [
        { payment_id: 'a', client_code: '00300', payment_date: '2026-05-02', payment_amount: 100, payment_ref: 'A' },
        { payment_id: 'b', client_code: '00300', payment_date: '2026-05-20', payment_amount: 200, payment_ref: 'B' },
        { payment_id: 'c', client_code: '00300', payment_date: '2026-06-05', payment_amount: 300, payment_ref: 'C' }
      ]
    })
  })

  assert.equal(profile.payment_behavior.average_payment_amount, 200)
  assert.equal(profile.payment_behavior.median_payment_amount, 200)
  assert.equal(profile.payment_behavior.maximum_payment_amount, 300)
})

test('payment intervals and next expected payment date are computed from unique payment days', async () => {
  const [profile] = await loadRecoveryProfiles({
    clientIds: ['13'],
    referenceDate: '2026-04-15',
    clientRows: [
      { client_id: '13', nbr_client: '00400', plafond: 1000, delai_paiement: 30 }
    ],
    queryRows: createQueryRowsMock({
      creditRows: [
        { client_code: '00400', credit_date: '2026-01-01', doc_solde: 400, doc_credit_amount: 400 }
      ],
      paymentRows: [
        { payment_id: 'a', client_code: '00400', payment_date: '2026-01-01', payment_amount: 100, payment_ref: 'A' },
        { payment_id: 'b', client_code: '00400', payment_date: '2026-02-01', payment_amount: 200, payment_ref: 'B' },
        { payment_id: 'c', client_code: '00400', payment_date: '2026-03-01', payment_amount: 300, payment_ref: 'C' }
      ]
    })
  })

  assert.equal(profile.payment_behavior.average_payment_interval_days, 29.5)
  assert.equal(profile.payment_behavior.median_payment_interval_days, 29.5)
  assert.equal(profile.payment_behavior.expected_next_payment_date, '2026-03-31')
  assert.equal(profile.payment_behavior.days_since_expected_payment, 15)
})

test('same-day payments are aggregated before interval computation', async () => {
  const [profile] = await loadRecoveryProfiles({
    clientIds: ['14'],
    referenceDate: '2026-02-01',
    clientRows: [
      { client_id: '14', nbr_client: '00500', plafond: 1000, delai_paiement: 30 }
    ],
    queryRows: createQueryRowsMock({
      creditRows: [
        { client_code: '00500', credit_date: '2025-12-15', doc_solde: 150, doc_credit_amount: 150 }
      ],
      paymentRows: [
        { payment_id: 'a', client_code: '00500', payment_date: '2026-01-01', payment_amount: 50, payment_ref: 'A' },
        { payment_id: 'b', client_code: '00500', payment_date: '2026-01-01', payment_amount: 25, payment_ref: 'B' },
        { payment_id: 'c', client_code: '00500', payment_date: '2026-01-10', payment_amount: 40, payment_ref: 'C' },
        { payment_id: 'd', client_code: '00500', payment_date: '2026-01-20', payment_amount: 60, payment_ref: 'D' }
      ]
    })
  })

  assert.equal(profile.payment_behavior.payment_count, 4)
  assert.equal(profile.payment_behavior.average_payment_interval_days, 9.5)
  assert.equal(profile.payment_behavior.median_payment_interval_days, 9.5)
  assert.equal(profile.payment_behavior.expected_next_payment_date, '2026-01-30')
  assert.equal(profile.payment_behavior.days_since_expected_payment, 2)
})

test('legacy recouvrement rows remain compatible with the historical /api/tournees/plan response shape', async () => {
  const profiles = await loadRecoveryProfiles({
    clientIds: ['15'],
    referenceDate: '2026-07-31',
    clientRows: [
      {
        client_id: '15',
        nbr_client: '00600',
        plafond: 1000,
        delai_paiement: 7,
        nom: 'Client Test',
        adresse: 'Adresse test',
        date_jour: '2026-07-31',
        commercia_zone: 'Comm C01 - Zone test',
        region: 'Nord',
        latitude: 36.8,
        longitude: 10.1
      }
    ],
    queryRows: createQueryRowsMock({
      creditRows: [
        { client_code: '00600', credit_date: '2026-06-01', doc_solde: 250, doc_credit_amount: 250 }
      ],
      paymentRows: [
        { payment_id: 'a', client_code: '00600', payment_date: '2026-06-15', payment_montant: 125 }
      ]
    })
  })

  const { rows, recoveryFilterMode } = buildRecoveryPlanRowsFromProfiles({
    profiles,
    clients: [
      {
        client_id: '15',
        nbr_client: '00600',
        plafond: 1000,
        delai_paiement: 7,
        nom: 'Client Test',
        adresse: 'Adresse test',
        date_jour: '2026-07-31',
        commercia_zone: 'Comm C01 - Zone test',
        region: 'Nord',
        latitude: 36.8,
        longitude: 10.1
      }
    ],
    distanceMap: new Map([['00600', 12.5]]),
    maxDistanceKm: 50
  })

  assert.equal(recoveryFilterMode, 'strict')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].collecte_prevue > 0, true)
  assert.equal(rows[0].score_ia > 0, true)
  // net_a_payer 250 moins le paiement 125 => reste 125
  assert.equal(rows[0].encours_credit, 125)
  assert.equal(rows[0].encours_total, 125)
  assert.equal(rows[0].last_payment_date, '2026-06-15')
  assert.equal(rows[0].avg_payment_amount, 125)
  assert.equal(rows[0].median_payment_amount, 125)
  assert.ok(Object.hasOwn(rows[0], 'collecte_prevue'))
  assert.ok(Object.hasOwn(rows[0], 'score_ia'))
  assert.ok(Object.hasOwn(rows[0], 'encours_credit'))
  assert.ok(Object.hasOwn(rows[0], 'encours_total'))
  assert.ok(Object.hasOwn(rows[0], 'last_payment_date'))
  assert.ok(Object.hasOwn(rows[0], 'avg_payment_amount'))
})

test('classifyRecoveryProfilesForPeriod keeps already due debt eligible', () => {
  const result = classifyRecoveryProfilesForPeriod({
    profiles: [
      createRecoveryProfile({
        client_id: 'due-1',
        client_code: '0100',
        credit: { total_balance: 320, due_amount: 320 }
      })
    ],
    startDate: '2026-08-01',
    endDate: '2026-08-31'
  })

  assert.equal(result.eligibleCount, 1)
  assert.equal(result.excludedCount, 0)
  assert.equal(result.eligibleProfiles[0].client_code, '0100')
  assert.equal(result.reasonCounts.positive_due_amount, 1)
})

test('classifyRecoveryProfilesForPeriod keeps expected payments in period or already overdue eligible', () => {
  const result = classifyRecoveryProfilesForPeriod({
    profiles: [
      createRecoveryProfile({
        client_id: 'window-1',
        client_code: '0200',
        payment_behavior: { expected_next_payment_date: '2026-08-20' }
      }),
      createRecoveryProfile({
        client_id: 'late-1',
        client_code: '0300',
        payment_behavior: { expected_next_payment_date: '2026-07-28' }
      })
    ],
    startDate: '2026-08-01',
    endDate: '2026-08-31'
  })

  assert.equal(result.eligibleCount, 2)
  assert.equal(result.excludedCount, 0)
  assert.deepEqual(
    result.eligibleProfiles.map(profile => profile.client_code),
    ['0200', '0300']
  )
  assert.equal(result.reasonCounts.expected_payment_in_period, 1)
  assert.equal(result.reasonCounts.expected_payment_overdue, 1)
})

test('classifyRecoveryProfilesForPeriod excludes future, zero-balance and missing-data profiles with explicit reasons', () => {
  const result = classifyRecoveryProfilesForPeriod({
    profiles: [
      createRecoveryProfile({
        client_id: 'future-1',
        client_code: '0400',
        payment_behavior: { expected_next_payment_date: '2026-09-15' }
      }),
      createRecoveryProfile({
        client_id: 'zero-1',
        client_code: '0500',
        credit: { total_balance: 0, due_amount: 0 }
      }),
      createRecoveryProfile({
        client_id: 'missing-1',
        client_code: '0600',
        credit: { total_balance: null, due_amount: null },
        payment_behavior: { expected_next_payment_date: null }
      })
    ],
    startDate: '2026-08-01',
    endDate: '2026-08-31'
  })

  assert.equal(result.eligibleCount, 0)
  assert.equal(result.excludedCount, 3)
  assert.deepEqual(
    result.excludedProfiles.map(profile => [profile.client_code, profile.reason]),
    [
      ['0400', 'payment_due_after_period'],
      ['0500', 'non_positive_total_balance'],
      ['0600', 'missing_recovery_data']
    ]
  )
  assert.equal(result.reasonCounts.payment_due_after_period, 1)
  assert.equal(result.reasonCounts.non_positive_total_balance, 1)
  assert.equal(result.reasonCounts.missing_recovery_data, 1)
})

test('classifyRecoveryProfilesForPeriod preserves exact identities 00152 and 152 and remains deterministic', () => {
  const profiles = [
    createRecoveryProfile({
      client_id: 'id-152',
      client_code: '152',
      payment_behavior: { expected_next_payment_date: '2026-08-18' }
    }),
    createRecoveryProfile({
      client_id: 'id-00152',
      client_code: '00152',
      payment_behavior: { expected_next_payment_date: '2026-08-18' }
    })
  ]

  const forward = classifyRecoveryProfilesForPeriod({
    profiles,
    startDate: '2026-08-01',
    endDate: '2026-08-31'
  })
  const reversed = classifyRecoveryProfilesForPeriod({
    profiles: [...profiles].reverse(),
    startDate: '2026-08-01',
    endDate: '2026-08-31'
  })

  assert.deepEqual(
    forward.eligibleProfiles.map(profile => [profile.client_id, profile.client_code]),
    [
      ['id-00152', '00152'],
      ['id-152', '152']
    ]
  )
  assert.deepEqual(
    reversed.eligibleProfiles.map(profile => [profile.client_id, profile.client_code]),
    [
      ['id-00152', '00152'],
      ['id-152', '152']
    ]
  )
  assert.deepEqual(forward.reasonCounts, reversed.reasonCounts)
  assert.equal(forward.totalCount, reversed.totalCount)
  assert.equal(forward.excludedCount, reversed.excludedCount)
})


test('allocateRecoveryPayments: imputation exacte via code_bl puis FIFO pour le reliquat', () => {
  const invoices = [
    { doc_code: 'BL1', doc_date: '2026-01-01', original_amount: 100, remaining: 100, matched_echeance: null },
    { doc_code: 'BL2', doc_date: '2026-02-01', original_amount: 100, remaining: 100, matched_echeance: null },
    { doc_code: 'BL3', doc_date: '2026-03-01', original_amount: 100, remaining: 100, matched_echeance: null }
  ]
  const payments = [
    { payment_code_bl: 'BL2', allocatable: 100, echeance: null },
    { payment_code_bl: null, allocatable: 50, echeance: null }
  ]
  allocateRecoveryPayments({ invoices, payments, creditNotesTotal: 0 })
  assert.equal(invoices[0].remaining, 50)  // 100 - 50 FIFO
  assert.equal(invoices[1].remaining, 0)   // imputation exacte
  assert.equal(invoices[2].remaining, 100)
})

test('allocateRecoveryPayments: les avoirs réduisent la dette (FIFO du plus ancien)', () => {
  const invoices = [
    { doc_code: 'A', doc_date: '2026-01-01', original_amount: 200, remaining: 200, matched_echeance: null },
    { doc_code: 'B', doc_date: '2026-02-01', original_amount: 200, remaining: 200, matched_echeance: null }
  ]
  allocateRecoveryPayments({ invoices, payments: [], creditNotesTotal: 250 })
  assert.equal(invoices[0].remaining, 0)
  assert.equal(invoices[1].remaining, 150)
})

test('loadRecoveryProfiles: paiement à crédit (montant vs credit) ne solde pas le BL', async () => {
  const [profile] = await loadRecoveryProfiles({
    clientIds: ['c-credit'],
    referenceDate: '2026-08-31',
    clientRows: [{ client_id: 'c-credit', nbr_client: '09000', plafond: 5000, delai_paiement: 7 }],
    queryRows: createQueryRowsMock({
      documentRows: [
        { client_code: '09000', doc_code: 'BLC1', doc_type: 'bl', doc_date: '2026-06-01', doc_net_a_payer: 410, doc_commercial_code: 'C1' }
      ],
      paymentRows: [
        // encaissé réel = montant - credit = 10.16
        { payment_id: 'p', client_code: '09000', payment_date: '2026-06-01', payment_montant: 410.16, payment_credit: 400, payment_code_bl: 'BLC1' }
      ]
    })
  })
  assert.ok(Math.abs(profile.credit.total_balance - 399.84) < 0.2)
  assert.equal(profile.credit.due_amount > 0, true)
})

test('loadRecoveryProfiles: commercial habituel = commercial_code dominant des BL', async () => {
  const [profile] = await loadRecoveryProfiles({
    clientIds: ['c-dom'],
    referenceDate: '2026-08-31',
    clientRows: [{ client_id: 'c-dom', nbr_client: '09100', plafond: 5000, delai_paiement: 7 }],
    queryRows: createQueryRowsMock({
      documentRows: [
        { client_code: '09100', doc_code: 'B1', doc_type: 'bl', doc_date: '2026-05-01', doc_net_a_payer: 100, doc_commercial_code: 'VL1900' },
        { client_code: '09100', doc_code: 'B2', doc_type: 'bl', doc_date: '2026-05-10', doc_net_a_payer: 100, doc_commercial_code: '1' },
        { client_code: '09100', doc_code: 'B3', doc_type: 'bl', doc_date: '2026-05-20', doc_net_a_payer: 100, doc_commercial_code: '1' }
      ]
    })
  })
  assert.equal(profile.legacy.dominant_commercial_code, '1')
})

test('loadRecoveryProfiles: le BL entièrement payé ne compte plus dans la dette', async () => {
  const profiles = await loadRecoveryProfiles({
    clientIds: ['c-paid'],
    referenceDate: '2026-08-31',
    clientRows: [{ client_id: 'c-paid', nbr_client: '09200', plafond: 5000, delai_paiement: 7 }],
    queryRows: createQueryRowsMock({
      documentRows: [
        { client_code: '09200', doc_code: 'P1', doc_type: 'bl', doc_date: '2026-06-01', doc_net_a_payer: 300 }
      ],
      paymentRows: [
        { payment_id: 'x', client_code: '09200', payment_date: '2026-06-20', payment_montant: 300 }
      ]
    })
  })
  assert.equal(profiles[0].credit.total_balance, null)
  assert.equal(profiles[0].sources.credit, null)
})


test('loadRecoveryProfiles: score IA de recouvrement (0-100) classe par dette/anciennete', async () => {
  const profiles = await loadRecoveryProfiles({
    clientIds: ['big', 'small'],
    referenceDate: '2026-08-31',
    clientRows: [
      { client_id: 'big', nbr_client: '07000', plafond: 20000, delai_paiement: 7 },
      { client_id: 'small', nbr_client: '07001', plafond: 20000, delai_paiement: 7 }
    ],
    queryRows: createQueryRowsMock({
      documentRows: [
        { client_code: '07000', doc_code: 'G1', doc_type: 'bl', doc_date: '2026-01-01', doc_net_a_payer: 9000 },
        { client_code: '07001', doc_code: 'S1', doc_type: 'bl', doc_date: '2026-07-01', doc_net_a_payer: 200 }
      ]
    })
  })
  const byId = new Map(profiles.map(p => [p.client_id, p]))
  const big = byId.get('big').recovery.collection_priority_score
  const small = byId.get('small').recovery.collection_priority_score
  assert.equal(typeof big, 'number')
  assert.ok(big >= 0 && big <= 100)
  assert.ok(big > small, `${big} should outrank ${small}`)
})


test('loadRecoveryProfiles: petite dette => collecte prevue = totalite (pas de reliquat)', async () => {
  const [profile] = await loadRecoveryProfiles({
    clientIds: ['sm'],
    referenceDate: '2026-08-31',
    clientRows: [{ client_id: 'sm', nbr_client: '08000', plafond: 5000, delai_paiement: 7 }],
    queryRows: createQueryRowsMock({
      documentRows: [
        { client_code: '08000', doc_code: 'B', doc_type: 'bl', doc_date: '2026-05-01', doc_net_a_payer: 286.2 }
      ],
      paymentRows: []
    })
  })
  assert.equal(profile.credit.total_balance, 286.2)
  assert.equal(profile.recovery.expected_collection_amount, 286.2)
})

test('loadRecoveryProfiles: grosse dette payee par tranches garde un partiel', async () => {
  const [profile] = await loadRecoveryProfiles({
    clientIds: ['bg'],
    referenceDate: '2026-08-31',
    clientRows: [{ client_id: 'bg', nbr_client: '08001', plafond: 50000, delai_paiement: 7 }],
    queryRows: createQueryRowsMock({
      documentRows: [
        { client_code: '08001', doc_code: 'B1', doc_type: 'bl', doc_date: '2026-01-01', doc_net_a_payer: 12000 }
      ],
      paymentRows: [
        { payment_id: 'a', client_code: '08001', payment_date: '2026-02-01', payment_montant: 800 },
        { payment_id: 'b', client_code: '08001', payment_date: '2026-03-01', payment_montant: 800 },
        { payment_id: 'c', client_code: '08001', payment_date: '2026-04-01', payment_montant: 800 }
      ]
    })
  })
  assert.ok(profile.credit.total_balance > 9000)
  assert.ok(profile.recovery.expected_collection_amount < profile.credit.total_balance,
    `${profile.recovery.expected_collection_amount} vs ${profile.credit.total_balance}`)
})
