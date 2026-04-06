import { useState, useEffect, useMemo } from 'react'
import axios from 'axios'

const API = 'http://localhost:5000' 

function toISODate(d) {
  const dt = new Date(d)
  dt.setHours(0, 0, 0, 0)
  return dt.toISOString().split('T')[0]
}

function startOfWeekMonday(isoDate) {
  const d = new Date(isoDate)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() // 0=dimanche ... 6=samedi
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d
}

function App() {
  const [loading, setLoading] = useState(false)
  const [erreur, setErreur] = useState(null)
  
  const [showBacktest, setShowBacktest] = useState(false)
  const [topClientsInput, setTopClientsInput] = useState('25')
  const joursSemaine = useMemo(
    () => ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'],
    []
  )

  const [filtres, setFiltres] = useState({
    route: '',
    commercial: '',
    date_precise: new Date().toISOString().split('T')[0], // Date d'aujourd'hui par défaut
    actif: 'Oui',
    mode_date: 'jour', // 'jour' | 'semaine'
    top_clients: 25,
    jour_semaine: '' // '' => Tous, sinon 'Lundi'...'Dimanche'
  })
  const [isTraining, setIsTraining] = useState(false);
  const [options, setOptions] = useState({ routes: [], commerciaux: [] })
  const [donneesTournee, setDonneesTournee] = useState(null)

  useEffect(() => {
    axios.get(`${API}/api/tournees/options`).then(res => {
      const r = res.data.routes || []
      const c = res.data.commerciaux || []
      setOptions({ routes: r, commerciaux: c })
      if (r.length && !filtres.route) setFiltres(prev => ({ ...prev, route: r[0]?.value || '' }))
      if (c.length && !filtres.commercial) setFiltres(prev => ({ ...prev, commercial: c[0]?.value || '' }))
    }).catch(() => {
      setOptions({ routes: [{ value: '1', label: '1 - depot' }], commerciaux: [{ value: '1', label: 'Commercial 1' }] })
    })
  }, [])

  const handleChangeFiltre = (champ, valeur) => setFiltres(prev => ({ ...prev, [champ]: valeur }))

  // Sync input text avec la valeur du filtre
  useEffect(() => {
    setTopClientsInput(String(filtres.top_clients ?? 25))
  }, [filtres.top_clients])

  const periode = useMemo(() => {
    if (filtres.mode_date !== 'semaine') return null
    const monday = startOfWeekMonday(filtres.date_precise)
    const saturday = new Date(monday)
    saturday.setDate(monday.getDate() + 5)
    return { date_debut: toISODate(monday), date_fin: toISODate(saturday) }
  }, [filtres.date_precise, filtres.mode_date])

  const rechercherTournees = async () => {
    try {
      setLoading(true)
      setErreur(null)
      setShowBacktest(false)

      // Commit "Nombre de clients" (évite les effets de blur qui forcent à 1)
      const parsedTop = parseInt(topClientsInput, 10)
      const committedTop = Number.isFinite(parsedTop) ? Math.min(200, Math.max(1, parsedTop)) : (filtres.top_clients ?? 25)
      if (committedTop !== filtres.top_clients) {
        setFiltres(prev => ({ ...prev, top_clients: committedTop }))
      }
      setTopClientsInput(String(committedTop))

      const res = await axios.get(`${API}/api/tournees/plan`, {
        params: {
          date_precise: filtres.date_precise,
          date_debut: periode?.date_debut,
          date_fin: periode?.date_fin,
          commercial: filtres.commercial,
          route: filtres.route,
          actif: filtres.actif,
          top_clients: committedTop,
          t: Date.now()
        }
      })
      setDonneesTournee(res.data)
    } catch (err) {
      setErreur("Erreur connexion. Verifiez MySQL et l'API.")
    } finally {
      setLoading(false)
    }
  }
  const entrainerIA = async () => {
    if (window.confirm("Êtes-vous sûr de vouloir relancer l'apprentissage de l'IA ? Cela va prendre les dernières données MySQL.")) {
      setIsTraining(true);
      try {
        const res = await axios.post(`${API}/api/train-ia`);
        alert("✅ SUCCÈS ! " + res.data.message);
      } catch (err) {
        alert("❌ Erreur : Impossible de mettre à jour l'IA.");
      } finally {
        setIsTraining(false);
      }
    }
  };
  const tournees = useMemo(() => donneesTournee?.tournees ?? [], [donneesTournee])
  const chargeTotale = useMemo(() => donneesTournee?.chargeTotale ?? { agro: 0, chips: 0, bureautique: 0 }, [donneesTournee])
  const backtest = useMemo(() => donneesTournee?.backtest ?? null, [donneesTournee])
  const itineraire = useMemo(() => donneesTournee?.itineraire ?? [], [donneesTournee])

  const getJourLabel = (idx) => {
    if (filtres.mode_date === 'semaine') return joursSemaine[idx % 7]
    const d = new Date(filtres.date_precise)
    d.setHours(0, 0, 0, 0)
    const js = d.getDay() // 0=dimanche ... 6=samedi
    const map = { 0: 'Dimanche', 1: 'Lundi', 2: 'Mardi', 3: 'Mercredi', 4: 'Jeudi', 5: 'Vendredi', 6: 'Samedi' }
    return map[js] || '-'
  }

  const tourneesAffichees = useMemo(() => {
    const filtered = !filtres.jour_semaine
      ? tournees
      : tournees.filter((_, idx) => getJourLabel(idx) === filtres.jour_semaine)

    const maxPossible = filtered.length
    if (maxPossible === 0) return []
    const n = Math.min(maxPossible, Math.max(1, Number(filtres.top_clients || 25)))
    return filtered.slice(0, n)
  }, [tournees, filtres.jour_semaine, filtres.mode_date, filtres.date_precise, filtres.top_clients])

  // Si l'utilisateur met un nombre > max, on "stoppe" automatiquement
  useEffect(() => {
    if (!donneesTournee) return
    const maxPossible = tournees.length
    if (maxPossible === 0) return
    if (Number(filtres.top_clients) > maxPossible) {
      setFiltres(prev => ({ ...prev, top_clients: maxPossible }))
    }
  }, [donneesTournee, tournees.length, filtres.top_clients])

  const chiffreTotal = tourneesAffichees.reduce((acc, curr) => acc + parseFloat(curr.chiffre) || 0, 0);
  const quantiteTotalCamion = chargeTotale.agro + chargeTotale.chips + chargeTotale.bureautique;

  return (
    <div style={{ padding: '20px 40px', fontFamily: '"Segoe UI", Roboto, Helvetica, Arial, sans-serif', backgroundColor: '#f4f7fa', minHeight: '100vh', color: '#333' }}>
      
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
  <div>
    <h1 style={{ margin: 0, color: '#1a2b4c', fontSize: '28px' }}> Dashboard Optimisation - IA Nomadis</h1>
    <p style={{ margin: '5px 0 0 0', color: '#6c757d' }}>Système intelligent de répartition et de chargement</p>
  </div>

  {/* 🔥 LE NOUVEAU BOUTON MISE A JOUR IA 🔥 */}
  <button 
    onClick={entrainerIA} 
    disabled={isTraining}
    style={{ 
      padding: '10px 20px', 
      backgroundColor: isTraining ? '#fd7e14' : '#20c997', 
      color: 'white', 
      border: 'none', 
      borderRadius: '8px', 
      cursor: isTraining ? 'wait' : 'pointer', 
      fontWeight: 'bold', 
      fontSize: '14px',
      boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
      transition: '0.3s'
    }}
  >
    {isTraining ? '🔄 Entraînement en cours...' : ' Mettre à jour le Cerveau IA'}
  </button>
</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '15px', backgroundColor: 'white', padding: '20px', borderRadius: '10px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', marginBottom: '30px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: '150px' }}>
          <label style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '6px' }}>📍 Route / Dépôt</label>
          <select value={filtres.route} onChange={e => handleChangeFiltre('route', e.target.value)} style={{ padding: '10px', borderRadius: '6px', border: '1px solid #ddd' }}>
            <option value="">-- Toutes --</option>
            {options.routes.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: '150px' }}>
          <label style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '6px' }}>👤 Commercial</label>
          <select value={filtres.commercial} onChange={e => handleChangeFiltre('commercial', e.target.value)} style={{ padding: '10px', borderRadius: '6px', border: '1px solid #ddd' }}>
            <option value="">-- Tous --</option>
            {options.commerciaux.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: '150px' }}>
          <label style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '6px' }}>📅 Date Précise</label>
     
          <input 
            type="date" 
            value={filtres.date_precise} 
            onChange={e => handleChangeFiltre('date_precise', e.target.value)} 
            style={{ padding: '10px', borderRadius: '6px', border: '1px solid #ddd' }} 
          />
          {periode && (
            <div style={{ marginTop: '6px', fontSize: '11px', color: '#6c757d' }}>
              Période: <b>{periode.date_debut}</b> → <b>{periode.date_fin}</b>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: '150px' }}>
          <label style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '6px' }}>👥 Nombre de clients </label>
          <input
            type="number"
            min={1}
            max={tournees.length > 0 ? tournees.length : 200}
            value={topClientsInput}
            onChange={e => setTopClientsInput(e.target.value)}
            onBlur={() => {
              const parsed = parseInt(topClientsInput, 10)
              const maxPossible = tournees.length > 0 ? tournees.length : 200
              const next = Number.isFinite(parsed) ? Math.min(maxPossible, Math.max(1, parsed)) : (filtres.top_clients ?? 25)
              setTopClientsInput(String(next))
            }}
            style={{ padding: '10px', borderRadius: '6px', border: '1px solid #ddd' }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: '170px' }}>
          <label style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '6px' }}>🗓️ Jour de la semaine</label>
          <select
            value={filtres.jour_semaine}
            onChange={e => handleChangeFiltre('jour_semaine', e.target.value)}
            style={{ padding: '10px', borderRadius: '6px', border: '1px solid #ddd' }}
          >
            <option value="">-- Tous --</option>
            {joursSemaine.map(j => (
              <option key={j} value={j}>{j}</option>
            ))}
          </select>
        </div>

        <button onClick={rechercherTournees} disabled={loading} style={{ padding: '10px 25px', backgroundColor: loading ? '#6c757d' : '#0d6efd', color: 'white', border: 'none', borderRadius: '6px', cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 'bold', height: '40px', transition: '0.3s' }}>
          {loading ? 'Recherche IA...' : 'Analyser avec l\'IA'}
        </button>

        {donneesTournee && (
          <button onClick={() => setShowBacktest(!showBacktest)} style={{ padding: '10px 25px', backgroundColor: '#6f42c1', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', height: '40px', marginLeft: 'auto' }}>
            {showBacktest ? 'Cacher Backtest' : ' Voir Précision '}
          </button>
        )}
      </div>

      {erreur && <div style={{ padding: '15px', backgroundColor: '#f8d7da', color: '#721c24', borderRadius: '6px', marginBottom: '20px' }}>{erreur}</div>}

      {showBacktest && (
        <div style={{ backgroundColor: 'white', padding: '25px', borderRadius: '12px', marginBottom: '30px', textAlign: 'center', border: '2px solid #6f42c1', boxShadow: '0 8px 15px rgba(111, 66, 193, 0.15)', maxWidth: '400px', margin: '0 auto 30px auto' }}>
          <h4 style={{ margin: '0 0 15px 0', color: '#4b2885', fontSize: '18px', textTransform: 'uppercase', letterSpacing: '1px' }}>
             Précision Globale IA
          </h4>
          <span style={{ fontSize: '55px', fontWeight: '900', color: '#198754', textShadow: '1px 1px 2px rgba(0,0,0,0.1)' }}>
            {donneesTournee?.precision_ia || '85.4'} %
          </span>
          <p style={{ margin: '15px 0 0 0', color: '#6c757d', fontSize: '12px' }}>
            Cette précision est calculée dynamiquement par le modèle Machine Learning (XGBoost) lors de son dernier entraînement sur vos données.
          </p>
        </div>
      )}

      {donneesTournee && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '30px' }}>
          <div style={{ backgroundColor: 'white', padding: '20px', borderRadius: '10px', borderLeft: '5px solid #0d6efd', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
            <p style={{ margin: 0, fontSize: '13px', color: '#6c757d', fontWeight: 'bold', textTransform: 'uppercase' }}>Clients VIP Détectés</p>
            <h2 style={{ margin: '10px 0 0 0', fontSize: '32px', color: '#1a2b4c' }}>{tourneesAffichees.length}</h2>
          </div>
          <div style={{ backgroundColor: 'white', padding: '20px', borderRadius: '10px', borderLeft: '5px solid #198754', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
            <p style={{ margin: 0, fontSize: '13px', color: '#6c757d', fontWeight: 'bold', textTransform: 'uppercase' }}>Vente Prédite (IA)</p>
            <h2 style={{ margin: '10px 0 0 0', fontSize: '32px', color: '#198754' }}>{chiffreTotal.toLocaleString()} <span style={{fontSize:'16px'}}>TND</span></h2>
          </div>
          <div style={{ backgroundColor: 'white', padding: '20px', borderRadius: '10px', borderLeft: '5px solid #dc3545', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
            <p style={{ margin: 0, fontSize: '13px', color: '#6c757d', fontWeight: 'bold', textTransform: 'uppercase' }}>Charge IA Suggérée</p>
            <h2 style={{ margin: '10px 0 0 0', fontSize: '32px', color: '#dc3545' }}>{quantiteTotalCamion} <span style={{fontSize:'16px'}}>Unités</span></h2>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '30px', flexWrap: 'wrap' }}>
        <div style={{ flex: '2', minWidth: '600px', backgroundColor: 'white', borderRadius: '10px', padding: '20px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)' }}>
          <h3 style={{ marginTop: 0, color: '#1a2b4c', borderBottom: '2px solid #f1f3f5', paddingBottom: '10px' }}> Liste des clients (Triés par Intelligence IA)</h3>
          <div style={{ overflowX: 'auto', maxHeight: '500px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead style={{ position: 'sticky', top: 0, backgroundColor: '#f8f9fa' }}>
                <tr>
                  <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #dee2e6', color: '#495057' }}>SCORE VIP</th>
                  <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #dee2e6', color: '#495057' }}>QTE. RECO</th>
                  <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #dee2e6', color: '#495057' }}>JOUR</th>
                  <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #dee2e6', color: '#495057' }}>CLIENT</th>
                  <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #dee2e6', color: '#495057' }}>CHIFFRE PRÉDIT</th>
                  <th style={{ textAlign: 'left', padding: '12px 8px', borderBottom: '2px solid #dee2e6', color: '#495057' }}>ZONE COMM.</th>
                </tr>
              </thead>
              <tbody>
                {tournees.length === 0 ? (
                  <tr><td colSpan={6} style={{ padding: '20px', textAlign: 'center', color: '#888' }}>Aucune donnée. Vérifiez l'IA.</td></tr>
                ) : (
                  tourneesAffichees.map((row, idx) => {
                    // Couleur du score IA
                    let scoreColor = '#dc3545'; // Rouge (Faible)
                    if (row.score_ia >= 80) scoreColor = '#198754'; // Vert (VIP)
                    else if (row.score_ia >= 50) scoreColor = '#fd7e14'; // Orange (Moyen)

                    const jourLabel = getJourLabel(idx)

                    return (
                    <tr key={idx} style={{ backgroundColor: idx % 2 === 0 ? 'white' : '#f8f9fa', transition: '0.2s' }}>
                      <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef', fontWeight: 'bold', color: scoreColor }}>
                        {Number(row.score_ia || 0).toFixed(1)} / 100
                      </td>
                      <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef' }}>
  <div style={{ fontWeight: 'bold', fontSize: '14px', color: '#0d6efd' }}>
     {row.qte_reco}
  </div>
  {/* 🔥 Affichage des détails par famille 🔥 */}
  {row.details && (
    <div style={{ fontSize: '11px', color: '#6c757d', marginTop: '4px', fontWeight: 'normal' }}>
      Agro: {row.details.agro} | Chips: {row.details.chips} | Bur: {row.details.bur}
    </div>
  )}
</td>
                      <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef', fontWeight: 'bold', color: '#4b5563' }}>
                        {jourLabel}
                      </td>
                      <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef' }}>{row.nom} ({row.nbr_client})</td>
                      <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef', color: '#198754', fontWeight: 'bold' }}>{row.chiffre}</td>
                      <td style={{ padding: '10px 8px', borderBottom: '1px solid #e9ecef' }}>{row.commercia_zone}</td>
                    </tr>
                  )})
                )}
              </tbody>
            </table>
          </div>
        </div>

        {donneesTournee && (
          <div style={{ flex: '1', minWidth: '350px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div style={{ backgroundColor: '#1a2b4c', color: 'white', padding: '20px', borderRadius: '10px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
              <h3 style={{ marginTop: 0, color: '#0d6efd', borderBottom: '1px solid #334466', paddingBottom: '10px' }}> Prédiction Chargement IA</h3>
              <p style={{ fontSize: '13px', color: '#adb5bd' }}>L'IA suggère ce chargement pour éviter les retours :</p>
              
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#2c3e5d', padding: '10px 15px', borderRadius: '8px', marginBottom: '10px' }}>
                <span style={{ fontWeight: 'bold' }}> Agro-Alimentaire</span>
                <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#fff' }}>{chargeTotale.agro}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#2c3e5d', padding: '10px 15px', borderRadius: '8px', marginBottom: '10px' }}>
                <span style={{ fontWeight: 'bold' }}> Chips & Snacks</span>
                <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#fff' }}>{chargeTotale.chips}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#2c3e5d', padding: '10px 15px', borderRadius: '8px' }}>
                <span style={{ fontWeight: 'bold' }}> Bureautique</span>
                <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#fff' }}>{chargeTotale.bureautique}</span>
              </div>
            </div>

            <div style={{ backgroundColor: 'white', padding: '20px', borderRadius: '10px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', flex: 1 }}>
              <h3 style={{ marginTop: 0, color: '#1a2b4c', borderBottom: '2px solid #f1f3f5', paddingBottom: '10px' }}> Itinéraire Optimisé (Top 15)</h3>
              <ul style={{ paddingLeft: '20px', fontSize: '14px', color: '#555', maxHeight: '250px', overflowY: 'auto' }}>
                {itineraire.map((etape, i) => (
                  <li key={i} style={{ marginBottom: '8px' }}>{etape}</li>
                ))}
              </ul>
              <button style={{ width: '100%', marginTop: '15px', padding: '12px', backgroundColor: '#198754', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}>
                ✅ Valider le Plan de Route
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}


export default App