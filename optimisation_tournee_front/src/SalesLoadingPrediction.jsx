import {
  formatSalesClientValue,
  formatSalesProductPredictionSource
} from './salesCoverageDetails.js'

function resolveProductTitle(product = {}) {
  return product.productLabel || product.productCode || 'Produit non disponible'
}

export default function SalesLoadingPrediction({ loadingPrediction = null }) {
  const products = Array.isArray(loadingPrediction?.products) ? loadingPrediction.products : []
  const coverage = loadingPrediction?.coverage || {}

  return (
    <div className="sales-loading-panel">
      <div className="sales-panel-title">Chargement estime</div>
      <p className="sales-panel-subtitle">
        Estimation de chargement par produit pour cette date et ce commercial. Aucun coefficient de securite arbitraire n est ajoute.
      </p>

      {loadingPrediction ? (
        <div className="sales-loading-meta">
          <span>{loadingPrediction.planningDate || 'Date non disponible'}</span>
          <span>{loadingPrediction.commercialCode || 'Commercial non disponible'}</span>
          <span>
            Couverture panier : {coverage.visitsWithBasketPrediction ?? 0}/{coverage.plannedVisits ?? 0}
            {coverage.basketPredictionCoveragePct != null ? ` (${coverage.basketPredictionCoveragePct} %)` : ''}
          </span>
        </div>
      ) : null}

      <div className="sales-loading-list">
        {products.length ? products.map(product => (
          <div
            key={`${product.productCode || product.productLabel || product.productId || 'product'}`}
            className="sales-loading-row sales-loading-row-stacked"
          >
            <div>
              <strong title={resolveProductTitle(product)}>{resolveProductTitle(product)}</strong>
              {product.productCode ? <span>{product.productCode}</span> : null}
            </div>
            <div className="sales-loading-metrics">
              <strong>{formatSalesClientValue(product.recommendedLoadQuantity ?? product.estimatedNeed)}</strong>
              <span>Besoin estime</span>
              <span>{formatSalesProductPredictionSource(product.predictionSource)}</span>
              {product.confidenceOrSupport != null ? <span>Support : {product.confidenceOrSupport}</span> : null}
            </div>
          </div>
        )) : (
          <div className="sales-loading-empty">Non disponible</div>
        )}
      </div>
    </div>
  )
}
