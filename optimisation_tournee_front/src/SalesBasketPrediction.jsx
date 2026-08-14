import {
  formatSalesClientValue,
  formatSalesProductPredictionSource
} from './salesCoverageDetails.js'

function resolveProductTitle(product = {}) {
  return product.productLabel || product.productCode || 'Produit non disponible'
}

function renderSupport(product = {}) {
  if (product.confidenceOrSupport == null || product.confidenceOrSupport === '') {
    return null
  }
  return `Support : ${product.confidenceOrSupport}`
}

export default function SalesBasketPrediction({ rows = [] }) {
  const items = Array.isArray(rows) ? rows : []

  return (
    <div className="sales-loading-panel">
      <div className="sales-panel-title">Panier estime</div>
      <p className="sales-panel-subtitle">
        Recommandation par client uniquement quand les donnees reelles permettent une estimation defensible.
      </p>

      <div className="sales-basket-list">
        {items.length ? items.map(row => (
          <div key={row.key} className="sales-basket-card">
            <div className="sales-basket-card-header">
              <strong>{row.clientName}</strong>
              <span>{row.clientCode}</span>
            </div>

            {row.predictedProducts.length ? (
              <div className="sales-loading-list">
                {row.predictedProducts.map(product => (
                  <div
                    key={`${row.key}-${product.productCode || product.productLabel || product.productId || 'product'}`}
                    className="sales-loading-row sales-loading-row-stacked"
                  >
                    <div>
                      <strong title={resolveProductTitle(product)}>{resolveProductTitle(product)}</strong>
                      {product.productCode ? <span>{product.productCode}</span> : null}
                    </div>
                    <div className="sales-loading-metrics">
                      <strong>{formatSalesClientValue(product.estimatedQuantity)}</strong>
                      <span>Besoin estime</span>
                      <span>{formatSalesProductPredictionSource(product.predictionSource)}</span>
                      {renderSupport(product) ? <span>{renderSupport(product)}</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="sales-loading-empty">Panier : Non disponible</div>
            )}
          </div>
        )) : (
          <div className="sales-loading-empty">Panier : Non disponible</div>
        )}
      </div>
    </div>
  )
}
