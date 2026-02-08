export interface UserAccount {
  id: string;
  domain: string;
  platform: string;
  username: string;
  profileUrl: string;
  detectedAt: number;
  lastSeenAt: number;
  isManual: boolean;
}
