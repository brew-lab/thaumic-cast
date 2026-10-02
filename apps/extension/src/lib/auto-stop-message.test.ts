import { describe, expect, it } from 'bun:test';

import en from '../locales/en.json';
import { autoStopMessageKey } from './auto-stop-message';
import { SpeakerRemovalReasonSchema } from './message-schemas';

const strings = en as Record<string, string>;

describe('autoStopMessageKey', () => {
  it('should use the cast-ended wording when the last speaker left', () => {
    expect(autoStopMessageKey('speaker_stopped', false)).toBe('auto_stop_speaker_stopped');
    expect(autoStopMessageKey('stream_ended', false)).toBe('auto_stop_stream_ended');
  });

  it('should use the carries-on wording when other speakers remain', () => {
    expect(autoStopMessageKey('speaker_stopped', true)).toBe('speaker_removed_speaker_stopped');
    expect(autoStopMessageKey('continuation_failed', true)).toBe(
      'speaker_removed_continuation_failed',
    );
  });

  it('should resolve to a string for every removal that is announced, either way', () => {
    const shown = SpeakerRemovalReasonSchema.options.filter((reason) => reason !== 'user_removed');
    for (const reason of shown) {
      expect(strings[autoStopMessageKey(reason, true)]).toBeString();
      expect(strings[autoStopMessageKey(reason, false)]).toBeString();
    }
  });

  it('should open both wordings of a reason with the same fact', () => {
    const shown = SpeakerRemovalReasonSchema.options.filter((reason) => reason !== 'user_removed');
    for (const reason of shown) {
      const ended = strings[autoStopMessageKey(reason, false)].replace(/ Cast again\.$/, '');
      expect(strings[autoStopMessageKey(reason, true)].startsWith(ended)).toBe(true);
    }
  });
});
