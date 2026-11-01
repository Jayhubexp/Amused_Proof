// Organizer session helpers. The CSRF token lives only in module memory (never
// localStorage): reloading the page simply requires logging in again.
import { apiDelete, apiGet, apiPatch, apiPost } from './api';

let csrfToken = '';

export function setOrganizerCsrf(token) {
  csrfToken = token;
}

export function clearOrganizerCsrf() {
  csrfToken = '';
}

export function organizerGet(path) {
  return apiGet(path);
}

export function organizerPost(path, payload) {
  return apiPost(path, payload, { csrfToken });
}

export function organizerPatch(path, payload) {
  return apiPatch(path, payload, { csrfToken });
}

export function organizerDelete(path) {
  return apiDelete(path, { csrfToken });
}
