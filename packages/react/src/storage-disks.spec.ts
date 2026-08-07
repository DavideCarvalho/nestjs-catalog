import { describe, expect, it } from 'vitest';
import { describeStorage } from './workflow/model';
import { SOURCE_KINDS } from './workflow/templates';

/**
 * What the screen says about naming a media disk.
 *
 * These are about the *sentences*, which is deliberate. The mechanism is easy
 * and is tested on the server; what goes wrong here is a screen that renders
 * nothing when media is absent, because nobody misses a picker they have never
 * seen — they type a bucket, mint a second copy of a credential the host
 * already holds, and no part of the UI ever told them there was another way.
 */
describe('describeStorage', () => {
  it('keeps "not reported" apart from "there are none"', () => {
    // A server older than the field has not been asked, which is not the same
    // as a server that said no. The same three-way split `describeDurability`
    // draws, and for the same reason.
    expect(describeStorage(undefined).state).toBe('unknown');
    expect(describeStorage(undefined).detail).toMatch(/did not say/);

    const none = describeStorage({ available: false, disks: [], detail: '' });
    expect(none.state).toBe('none');
    expect(none.detail).toMatch(/No media storage manager resolved/);
  });

  it('says what is LOST when there is no manager, not merely that one is missing', () => {
    const none = describeStorage({ available: false, disks: [], detail: '' });
    // The cost is a second copy of a credential, and naming it is the whole
    // reason this line is rendered rather than the picker simply being hidden.
    expect(none.detail).toMatch(/second copy of a credential/);
    expect(none.detail).toMatch(/accessKeyId:secretAccessKey/);
    // And it does not overstate: an object store still works without media.
    expect(none.detail).toMatch(/still reads an object store/);
  });

  it('separates a manager with no disks from no manager at all', () => {
    const empty = describeStorage({ available: true, disks: [], detail: '' });
    expect(empty.state).toBe('none');
    expect(empty.detail).toMatch(/no disks configured/);
    expect(empty.detail).not.toMatch(/second copy of a credential/);
  });

  it('names the disks that can be chosen', () => {
    const some = describeStorage({ available: true, disks: ['drops', 'archive'], detail: '' });
    expect(some.state).toBe('disks');
    expect(some.label).toBe('disks: 2');
    expect(some.detail).toMatch(/drops, archive/);
  });
});

describe('the s3 source profile', () => {
  it('offers a disk without making it the required answer', () => {
    // Optional rather than an alternative `required` set: a deployment with no
    // media has no disks to name, and `bucket` is still the answer there.
    expect(SOURCE_KINDS.s3.optional).toContain('disk');
    expect(SOURCE_KINDS.s3.required).toEqual(['bucket']);
  });
});
