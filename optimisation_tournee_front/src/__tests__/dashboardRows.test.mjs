import test from 'node:test'
import assert from 'node:assert/strict'

import { filterVisibleDashboardRows } from '../dashboardRows.js'

test("les lignes Vente a quantite nulle sont exclues de l'affichage et des totaux", () => {
  const rows = [
    { nbr_client: '00152', qte_reco: 0, chiffre_brut: 120 },
    { nbr_client: '00158', qte_reco: 3, chiffre_brut: 90 },
    { nbr_client: '00159', qte_reco: 2, chiffre_brut: 50 }
  ]

  const visibleRows = filterVisibleDashboardRows(rows, {
    isRecouvrementMode: false,
    topClients: null
  })

  assert.deepEqual(
    visibleRows.map(row => row.nbr_client),
    ['00158', '00159']
  )
  assert.equal(
    visibleRows.reduce((sum, row) => sum + Number(row.chiffre_brut || 0), 0),
    140
  )
})

test('le recouvrement conserve ses lignes meme si la quantite vaut zero', () => {
  const rows = [
    { nbr_client: '00152', qte_reco: 0, chiffre_brut: 120 }
  ]

  const visibleRows = filterVisibleDashboardRows(rows, {
    isRecouvrementMode: true,
    topClients: null
  })

  assert.equal(visibleRows.length, 1)
  assert.equal(visibleRows[0].nbr_client, '00152')
})
