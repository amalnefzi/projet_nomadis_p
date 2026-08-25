export const DASHBOARD_VALIDATION_COMMERCIAL_REQUIRED_MESSAGE = "Selectionnez un commercial avant d'enregistrer la tournee."

export function shouldRequireDashboardCommercialForValidation({ modeTournee } = {}) {
  return modeTournee === 'vente' || modeTournee === 'recouvrement'
}

export function getDashboardCommercialValidationMessage({ modeTournee, commercialCode } = {}) {
  if (!shouldRequireDashboardCommercialForValidation({ modeTournee })) {
    return null
  }

  if (String(commercialCode || '').trim()) {
    return null
  }

  return DASHBOARD_VALIDATION_COMMERCIAL_REQUIRED_MESSAGE
}

export function getDashboardValidationDisabledReason({
  validationLoading,
  stopCount,
  modeTournee,
  commercialCode
} = {}) {
  if (validationLoading) {
    return 'Validation en cours...'
  }

  const commercialValidationMessage = getDashboardCommercialValidationMessage({
    modeTournee,
    commercialCode
  })
  if (commercialValidationMessage) {
    return commercialValidationMessage
  }

  if (!Number(stopCount || 0)) {
    return 'Aucun client a enregistrer pour ce plan de route.'
  }

  return null
}
