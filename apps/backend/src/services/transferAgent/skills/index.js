/**
 * Venue skill dispatcher — selects the correct skill builder based on venue.
 *
 * This is the single entry point all agent nodes should use instead of
 * importing venue-specific skill builders directly.
 */

import { buildNeuripsSkillFromState } from './neurips.js';
import { buildIcmlSkillFromState } from './icml.js';
import { buildCvprSkillFromState } from './cvpr.js';
import { buildAclSkillFromState } from './acl.js';

/**
 * Resolve the venue from state (checks transferIntake.venue and transferGraphKind).
 */
function resolveVenue(state) {
  const intake = state.transferIntake || {};
  return intake.venue || state.transferGraphKind || '';
}

/**
 * Build the venue-specific skill system prompt from state.
 *
 * @param {object} state — LangGraph TransferState
 * @returns {Promise<string>} — The system prompt string
 */
export async function buildVenueSkillFromState(state) {
  const venue = resolveVenue(state);
  switch (venue) {
    case 'cvpr':
      return buildCvprSkillFromState(state);
    case 'acl':
      return buildAclSkillFromState(state);
    case 'icml':
      return buildIcmlSkillFromState(state);
    case 'neurips':
    default:
      return buildNeuripsSkillFromState(state);
  }
}
