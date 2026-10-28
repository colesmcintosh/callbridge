import { AppError, plainNote } from './domain.js';

const SAMPLE_CONTACTS = [
  { id: '1001', properties: { firstname: 'Maya', lastname: 'Chen', email: 'maya.chen@example.com', company: 'Northstar', jobtitle: 'RevOps lead', phone: '' } },
  { id: '1002', properties: { firstname: 'Jordan', lastname: 'Lee', email: 'jordan.lee@example.com', company: 'Acme Studio', jobtitle: 'Founder', phone: '' } },
];

// The same provider contract exercises the real review/sync workflow, without HubSpot requests.
export function createMockHubSpot(store) {
  store.seedMockContacts(SAMPLE_CONTACTS);
  return {
    async findContact(email) {
      const contact = store.mockContacts().find(item => item.properties.email.toLowerCase() === email.toLowerCase());
      if (!contact) throw new AppError(404, 'No mock contact matches this email. Try maya.chen@example.com or jordan.lee@example.com.');
      return contact;
    },
    async getContact(id) { return store.mockContact(id); },
    async createNote(call, contactId) {
      store.mockContact(contactId);
      return store.addMockNote({ contactId, callId: call.id, body: plainNote(call) });
    },
    async updateContact(id, properties) {
      if (Object.keys(properties).some(key => !['company', 'jobtitle', 'phone'].includes(key))) {
        throw new AppError(400, 'Unsupported mock contact property.');
      }
      const contact = store.mockContact(id);
      store.updateMockContact(id, { ...contact.properties, ...properties });
    },
  };
}
