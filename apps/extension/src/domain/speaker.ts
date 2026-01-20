/**
 * Speaker Domain Model
 *
 * Type-safe domain classes for Sonos speakers and groups.
 * Encapsulates speaker operations and provides equality semantics.
 *
 * Benefits:
 * - Type safety: Speaker IPs are no longer raw strings
 * - Encapsulated operations: containsSpeaker, findMember, etc.
 * - Equality semantics: explicit equals() method
 * - Factory functions: easy conversion from protocol types
 */

import type { ZoneGroup, ZoneGroupMember } from '@thaumic-cast/protocol';

/**
 * Represents a single Sonos speaker.
 * Immutable value object identified by IP address.
 */
export class Speaker {
  /**
   * Creates a new Speaker instance.
   * @param ip - The speaker's IP address
   * @param name - The speaker's display name (zone name)
   * @param uuid - Optional unique identifier
   * @param model - Optional model name
   */
  constructor(
    readonly ip: string,
    readonly name: string,
    readonly uuid?: string,
    readonly model?: string,
  ) {}

  /**
   * Checks equality with another speaker by IP address.
   * @param other - The speaker to compare with
   * @returns True if both speakers have the same IP
   */
  equals(other: Speaker): boolean {
    return this.ip === other.ip;
  }

  /**
   * Checks if this speaker has the given IP address.
   * @param ip - The IP address to check
   * @returns True if this speaker has the given IP
   */
  hasIp(ip: string): boolean {
    return this.ip === ip;
  }

  /**
   * Returns a string representation for debugging.
   * @returns String in format "Speaker(name @ ip)"
   */
  toString(): string {
    return `Speaker(${this.name} @ ${this.ip})`;
  }

  /**
   * Creates a Speaker from a ZoneGroupMember.
   * @param member - The zone group member from protocol
   * @returns A new Speaker instance
   */
  static fromMember(member: ZoneGroupMember): Speaker {
    return new Speaker(member.ip, member.zoneName, member.uuid, member.model);
  }
}

/**
 * Represents a Sonos zone group (one or more speakers playing in sync).
 * The coordinator is the "master" speaker that receives playback commands.
 */
export class SpeakerGroup {
  /**
   * Creates a new SpeakerGroup instance.
   * @param id - The group's unique identifier
   * @param name - The group's display name
   * @param coordinator - The coordinator speaker
   * @param members - All speakers in the group (including coordinator)
   */
  constructor(
    readonly id: string,
    readonly name: string,
    readonly coordinator: Speaker,
    readonly members: readonly Speaker[],
  ) {}

  /**
   * The coordinator's IP address.
   * Convenience accessor for the most common lookup pattern.
   * @returns The coordinator's IP address
   */
  get coordinatorIp(): string {
    return this.coordinator.ip;
  }

  /**
   * The number of speakers in the group.
   * @returns The speaker count
   */
  get size(): number {
    return this.members.length;
  }

  /**
   * Whether this is a stereo pair or bonded group (multiple physical speakers).
   * @returns True if the group has multiple speakers
   */
  get isMultiSpeaker(): boolean {
    return this.members.length > 1;
  }

  /**
   * Checks if the group contains a speaker with the given IP.
   * @param ip - The IP address to check
   * @returns True if the group contains a speaker with this IP
   */
  containsSpeaker(ip: string): boolean {
    return this.members.some((member) => member.hasIp(ip));
  }

  /**
   * Checks if the given IP is the coordinator.
   * @param ip - The IP address to check
   * @returns True if this IP is the coordinator
   */
  isCoordinator(ip: string): boolean {
    return this.coordinator.hasIp(ip);
  }

  /**
   * Finds a member by IP address.
   * @param ip - The IP address to find
   * @returns The Speaker if found, undefined otherwise
   */
  findMember(ip: string): Speaker | undefined {
    return this.members.find((member) => member.hasIp(ip));
  }

  /**
   * Gets all member IPs as an array.
   * @returns Array of IP addresses
   */
  getMemberIps(): string[] {
    return this.members.map((member) => member.ip);
  }

  /**
   * Checks equality with another group by ID.
   * @param other - The group to compare with
   * @returns True if both groups have the same ID
   */
  equals(other: SpeakerGroup): boolean {
    return this.id === other.id;
  }

  /**
   * Returns a string representation for debugging.
   * @returns String in format "SpeakerGroup(name, N speakers)"
   */
  toString(): string {
    return `SpeakerGroup(${this.name}, ${this.size} speaker${this.size === 1 ? '' : 's'})`;
  }

  /**
   * Creates a SpeakerGroup from a ZoneGroup.
   * @param group - The zone group from protocol
   * @returns A new SpeakerGroup instance
   */
  static fromZoneGroup(group: ZoneGroup): SpeakerGroup {
    const members = group.members.map(Speaker.fromMember);
    const coordinator =
      members.find((m) => m.ip === group.coordinatorIp) ??
      new Speaker(group.coordinatorIp, group.name);

    return new SpeakerGroup(group.id, group.name, coordinator, members);
  }
}

/**
 * Collection of speaker groups with lookup operations.
 * Provides convenient methods for finding groups and speakers.
 */
export class SpeakerGroupCollection {
  private readonly groupsByCoordinatorIp: Map<string, SpeakerGroup>;

  /**
   * Creates a new collection from an array of groups.
   * @param groups - The speaker groups to include
   */
  constructor(readonly groups: readonly SpeakerGroup[]) {
    this.groupsByCoordinatorIp = new Map(groups.map((g) => [g.coordinatorIp, g]));
  }

  /**
   * The number of groups in the collection.
   * @returns The group count
   */
  get size(): number {
    return this.groups.length;
  }

  /**
   * Whether the collection is empty.
   * @returns True if no groups exist
   */
  get isEmpty(): boolean {
    return this.groups.length === 0;
  }

  /**
   * Finds a group by its coordinator IP.
   * @param ip - The coordinator IP to find
   * @returns The SpeakerGroup if found, undefined otherwise
   */
  findByCoordinatorIp(ip: string): SpeakerGroup | undefined {
    return this.groupsByCoordinatorIp.get(ip);
  }

  /**
   * Finds the group containing a speaker with the given IP.
   * @param ip - The speaker IP to find
   * @returns The SpeakerGroup containing this speaker, or undefined
   */
  findGroupContainingSpeaker(ip: string): SpeakerGroup | undefined {
    return this.groups.find((group) => group.containsSpeaker(ip));
  }

  /**
   * Gets the group name for a coordinator IP.
   * Convenience method for common lookup pattern.
   * @param coordinatorIp - The coordinator IP
   * @returns The group name if found, or the IP as fallback
   */
  getGroupName(coordinatorIp: string): string {
    return this.groupsByCoordinatorIp.get(coordinatorIp)?.name ?? coordinatorIp;
  }

  /**
   * Gets all coordinator IPs.
   * @returns Array of coordinator IP addresses
   */
  getCoordinatorIps(): string[] {
    return this.groups.map((g) => g.coordinatorIp);
  }

  /**
   * Sorts items by their associated group name.
   * Used to ensure consistent alphabetical ordering in UI.
   * @param items - Array to sort
   * @param getIp - Function to extract speaker IP from each item
   * @returns Sorted copy of the array
   */
  sortByGroupName<T>(items: T[], getIp: (item: T) => string): T[] {
    return [...items].sort((a, b) =>
      this.getGroupName(getIp(a)).localeCompare(this.getGroupName(getIp(b))),
    );
  }

  /**
   * Iterates over all groups.
   * @returns An iterator over all speaker groups
   */
  [Symbol.iterator](): Iterator<SpeakerGroup> {
    return this.groups[Symbol.iterator]();
  }

  /**
   * Creates a collection from an array of ZoneGroups.
   * Groups are sorted alphabetically by name for consistent UI ordering.
   * @param groups - The zone groups from protocol
   * @returns A new SpeakerGroupCollection
   */
  static fromZoneGroups(groups: ZoneGroup[]): SpeakerGroupCollection {
    const sorted = [...groups].sort((a, b) => a.name.localeCompare(b.name));
    return new SpeakerGroupCollection(sorted.map(SpeakerGroup.fromZoneGroup));
  }
}
