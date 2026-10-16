import { complaintTemplates } from './templates.mjs';

export function mapComplaints(text, selectedComplaints = [], existingComplaints = []) {
  const normalized = String(text ?? '').trim();
  const scores = new Map();
  // These values are background scan tags only. They can help organize the
  // clinician summary, but no tag is allowed to select or suppress questions.
  for (const id of existingComplaints) scores.set(id, (scores.get(id) ?? 0) + 3);
  for (const id of selectedComplaints) scores.set(id, (scores.get(id) ?? 0) + 2);

  for (const template of complaintTemplates) {
    for (const keyword of template.triggerKeywords) {
      if (normalized.includes(keyword)) {
        scores.set(template.complaintId, (scores.get(template.complaintId) ?? 0) + 2);
      }
    }
  }

  const ranked = [...scores.entries()]
    .filter(([id, score]) => score > 0 && id !== 'generic_behavioral_health')
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  if (ranked.length === 0) return ['generic_behavioral_health'];
  return ranked;
}
