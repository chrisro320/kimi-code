import type {
  ReferenceAuditDecision,
  ReferenceAuditRequest,
  ReferenceDescriptor,
} from './types';

function isMaterialReference(reference: ReferenceDescriptor): boolean {
  return reference.trivial !== true && reference.role !== 'visual';
}

function isPurelyVisualSet(references: readonly ReferenceDescriptor[]): boolean {
  return references.length > 0 && references.every((reference) => reference.role === 'visual');
}

export function classifyReferenceAudit(request: ReferenceAuditRequest): ReferenceAuditDecision {
  const references = request.references;
  const narrowQuestion = request.explicitNarrowQuestion?.trim();
  const requestedIntensity = request.requestedIntensity;

  if (requestedIntensity === 'targeted') {
    if (narrowQuestion === undefined || narrowQuestion.length === 0) {
      throw new Error('Targeted reference audit requires an explicit narrow question.');
    }
    if (references.length === 0) {
      return { triggered: false, reason: 'No references were supplied for the targeted audit.' };
    }
    return {
      triggered: true,
      intensity: 'targeted',
      reason: 'The user explicitly narrowed the audit to one verifiable question.',
      narrowQuestion,
    };
  }

  if (references.length === 0) {
    return { triggered: false, reason: 'No project, product, repository, link, or media references were supplied.' };
  }

  const materialReferences = references.filter(isMaterialReference);
  const crossProduct = request.crossProductMashup === true;
  const jointTarget = request.jointlyDefineTarget === true;
  const deepRequested = requestedIntensity === 'deep';

  // Explicit deep signals take precedence over the narrow visual/trivial skip.
  // The caller has stated that these references materially define the target.
  if (crossProduct || jointTarget || deepRequested) {
    return {
      triggered: true,
      intensity: 'deep',
      reason: crossProduct
        ? 'The request combines multiple products and needs a deep cross-product reference audit.'
        : jointTarget
          ? 'The supplied examples jointly define the target and require a deep reference audit.'
          : 'The user explicitly requested a deep reference audit.',
    };
  }

  if (references.length === 1 && references[0]!.trivial === true) {
    return {
      triggered: false,
      reason: 'The only supplied reference is explicitly marked trivial, so no material claim depends on it.',
    };
  }

  if (isPurelyVisualSet(references)) {
    return {
      triggered: false,
      reason: 'The supplied references are purely visual and no behavioral or technical comparison was requested.',
    };
  }

  if (references.length >= 2 && (materialReferences.length > 0 || references.some((reference) => reference.role === 'mixed'))) {
    return {
      triggered: true,
      intensity: 'standard',
      reason: 'Multiple behavioral, technical, or mixed references require comparison before material planning or routing.',
    };
  }

  return {
    triggered: false,
    reason: 'The supplied references do not establish a material behavioral or technical comparison.',
  };
}
