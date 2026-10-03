export type SafeTunnelDesiredState = "enabled" | "disabled";

export type SafeTunnelAccountAccessStatus =
  | "account_access_payment_required"
  | "account_access_suspended"
  | "account_access_deactivated";

/** Provider-neutral account-access guidance supplied by the hosted Control API. */
export interface SafeTunnelAccountAccessNotice {
  status: SafeTunnelAccountAccessStatus;
  message: string;
  dashboardUrl: string;
}
