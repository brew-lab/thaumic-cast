import { describe, expect, it } from 'bun:test';
import { shownError } from './AddressField/state';
import { copyResultFor } from './CopyField/result';
import { fieldMessage } from './Field/message';
import { noticeAnnouncement } from './Notice/tone';

// The pure parts of the molecules; their behaviour in a browser is in
// catalogue/tests/molecules.pw.ts.

describe('Field message slot', () => {
  it('should let the error replace the status, and the status replace the help', () => {
    expect(fieldMessage({ help: 'h', status: 's', error: 'e' })).toBe('error');
    expect(fieldMessage({ help: 'h', status: 's' })).toBe('status');
    expect(fieldMessage({ help: 'h' })).toBe('help');
  });

  it('should leave the slot empty when there is nothing to say', () => {
    expect(fieldMessage({})).toBeNull();
    expect(fieldMessage({ help: '', status: false })).toBeNull();
  });
});

describe('CopyField results', () => {
  it('should be done when the clipboard took the text, refused when it did not', () => {
    expect(copyResultFor('copied', 'http://x')).toBe('done');
    expect(copyResultFor('refused', 'http://x')).toBe('refused');
  });

  it('should be unavailable when there was no text, whatever the clipboard said', () => {
    expect(copyResultFor('copied', null)).toBe('unavailable');
    expect(copyResultFor('refused', null)).toBe('unavailable');
  });
});

describe('AddressField errors', () => {
  it('should show a validation message before a failed request', () => {
    expect(shownError('Not an address', { ok: false, error: 'Nothing answered' })).toBe(
      'Not an address',
    );
  });

  it("should show a failed request's answer, and nothing after success", () => {
    expect(shownError(undefined, { ok: false, error: 'Nothing answered' })).toBe(
      'Nothing answered',
    );
    expect(shownError(undefined, { ok: true })).toBeUndefined();
    expect(shownError(undefined, null)).toBeUndefined();
  });
});

describe('Notice announcements', () => {
  it('should say the lead and the text as one sentence', () => {
    expect(noticeAnnouncement({ lead: 'Kitchen cut out', text: 'Raise it.' })).toEqual({
      message: 'Kitchen cut out. Raise it.',
      urgent: false,
    });
  });

  it('should put the spoken prefix before the lead, and keep urgency', () => {
    expect(
      noticeAnnouncement({ prefix: 'While you were away:', lead: 'Cast ended', urgent: true }),
    ).toEqual({ message: 'While you were away: Cast ended', urgent: true });
  });

  it('should say nothing for a notice with no words', () => {
    expect(noticeAnnouncement({})).toBeNull();
  });
});
