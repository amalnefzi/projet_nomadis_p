import { useState } from 'react'
import axios from 'axios'

function App() {
  const [suggestion, setSuggestion] = useState(null)
  const [loading, setLoading] = useState(false)
  const [erreur, setErreur] = useState(null)

  const genererSuggestion = () => {
    setLoading(true)
    setErreur(null)
    
    // On ajoute un paramètre aléatoire (t=...) pour éviter que le navigateur garde l'ancienne réponse en mémoire cache
    axios.get(`http://localhost:5000/api/ia/suggestion?t=${new Date().getTime()}`)
      .then(res => {
        setSuggestion(res.data)
        setLoading(false)
      })
      .catch(err => {
        console.error(err)
        setErreur("Erreur lors de la connexion au serveur IA.")
        setLoading(false)
      })
  }

  return (
    <div style={{ padding: '30px', fontFamily: 'Segoe UI, Arial, sans-serif' }}>
      <h1>Système d'IA - Optimisation Nomadis</h1>
      
      <div style={{ marginBottom: '20px', padding: '20px', backgroundColor: '#eef2f7', borderRadius: '10px' }}>
        <h3>Besoin d'aide pour la tournée d'aujourd'hui ?</h3>
        <button 
          onClick={genererSuggestion} 
          disabled={loading}
          style={{ 
            padding: '12px 24px', 
            backgroundColor: loading ? '#ccc' : '#007bff', 
            color: 'white', 
            border: 'none', 
            borderRadius: '5px', 
            cursor: loading ? 'not-allowed' : 'pointer',
            fontSize: '16px',
            fontWeight: 'bold'
          }}
        >
          {loading ? '⏳ Analyse de l\'IA en cours...' : '🤖 Suggérer ma tournée optimale'}
        </button>
        
        {erreur && <p style={{ color: 'red', marginTop: '10px' }}>{erreur}</p>}
      </div>

      {/* On vérifie que suggestion existe bien avant de l'afficher */}
      {suggestion && (
        <div style={{ border: '2px solid #28a745', padding: '20px', borderRadius: '10px', marginTop: '20px' }}>
          <h2 style={{ color: '#28a745', marginTop: 0 }}>🚚 Feuille de Route de l'IA</h2>
          <p><strong>Région cible :</strong> {suggestion?.titre || suggestion?.zone || "Non spécifiée"}</p>
          <p><strong>Stratégie :</strong> {suggestion?.strategie || "Non spécifiée"}</p>
          <p><strong>Nombre d'arrêts :</strong> {suggestion?.nombreArrets || (suggestion?.itineraire?.length)} clients</p>
          
          <div style={{ display: 'flex', gap: '20px', marginTop: '20px', flexWrap: 'wrap' }}>
            
            {/* Colonne de gauche : Ce qu'il faut charger */}
            <div style={{ flex: 1, minWidth: '250px', backgroundColor: '#f8f9fa', padding: '15px', borderRadius: '8px' }}>
              <h4 style={{ marginTop: 0 }}>📦 À charger dans le camion :</h4>
              <ul style={{ fontSize: '18px', fontWeight: 'bold', color: '#dc3545', listStyleType: 'none', paddingLeft: 0 }}>
                {/* On utilise ?. pour éviter les erreurs de type "undefined" */}
                <li style={{ padding: '5px 0' }}>🌾 Agro : {suggestion?.chargeTotale?.agro || suggestion?.charge?.agro || 0} unités</li>
                <li style={{ padding: '5px 0' }}>🥔 Chips : {suggestion?.chargeTotale?.chips || suggestion?.charge?.chips || 0} unités</li>
                <li style={{ padding: '5px 0' }}>🖨️ Bureautique : {suggestion?.chargeTotale?.bureautique || suggestion?.charge?.bureautique || 0} unités</li>
              </ul>
              <p style={{ fontSize: '12px', color: '#6c757d', fontStyle: 'italic' }}>
                *Quantité calculée pour couvrir l'ensemble des arrêts de cette tournée.
              </p>
            </div>

            {/* Colonne de droite : L'itinéraire */}
            <div style={{ flex: 1, minWidth: '250px', backgroundColor: '#e9ecef', padding: '15px', borderRadius: '8px' }}>
              <h4 style={{ marginTop: 0 }}>📍 Itinéraire de la journée :</h4>
              <ol style={{ paddingLeft: '20px' }}>
                {suggestion?.itineraire?.map((etape, index) => (
                  <li key={index} style={{ marginBottom: '8px', fontWeight: '500' }}>{etape}</li>
                ))}
              </ol>
            </div>

          </div>

          <button style={{ 
            marginTop: '20px', 
            padding: '12px 24px', 
            backgroundColor: '#28a745', 
            color: 'white', 
            border: 'none', 
            borderRadius: '5px', 
            cursor: 'pointer', 
            fontSize: '16px',
            width: '100%',
            fontWeight: 'bold'
          }}>
            ✅ Valider cette tournée et assigner au livreur
          </button>
        </div>
      )}
    </div>
  )
}

export default App