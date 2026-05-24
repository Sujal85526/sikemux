import { awsApi, type AwsStatus } from "../../api/aws";
import type { Slice } from "./types";

export type AwsService =
  | "ecs"
  | "ec2"
  | "lambda"
  | "sqs"
  | "billing"
  | "s3";

export const AWS_SERVICES: AwsService[] = [
  "ecs",
  "ec2",
  "lambda",
  "sqs",
  "billing",
  "s3",
];

export interface AwsProfileStatus {
  status: AwsStatus;
  arn: string | null;
  account: string | null;
  message: string | null;
  checkedAt: number;
}

export interface AwsSlice {
  /** Currently-selected AWS profile name (drives top bar chip, picker). */
  awsProfile: string | null;
  /** Which submodule the AWS pane is on. */
  awsService: AwsService;
  /** Status keyed by profile name. */
  awsStatuses: Record<string, AwsProfileStatus>;
  /** Auth modal control. */
  awsAuthModal: { profile: string; ssoStartUrl: string | null } | null;

  setAwsProfile: (name: string | null) => void;
  setAwsService: (s: AwsService) => void;
  refreshAwsStatus: (profile: string, force?: boolean) => Promise<void>;
  openAwsAuthModal: (profile: string, ssoStartUrl: string | null) => void;
  closeAwsAuthModal: () => void;
  runAwsSsoLogin: (profile: string) => Promise<boolean>;
}

export const createAwsSlice: Slice<AwsSlice> = (set, get) => ({
  awsProfile: null,
  awsService: "ecs",
  awsStatuses: {},
  awsAuthModal: null,

  setAwsProfile: (name) => set({ awsProfile: name }),
  setAwsService: (s) => set({ awsService: s }),

  refreshAwsStatus: async (profile, force = false) => {
    // Mark "checking" so the chip can show a spinner without flipping to
    // red on every poll. We commit the cached value on the way back.
    set((st) => ({
      awsStatuses: {
        ...st.awsStatuses,
        [profile]: {
          ...(st.awsStatuses[profile] ?? {
            arn: null,
            account: null,
            message: null,
            checkedAt: 0,
          }),
          status: "checking",
        },
      },
    }));
    try {
      const id = await awsApi.identity(profile, force);
      set((st) => ({
        awsStatuses: {
          ...st.awsStatuses,
          [profile]: {
            status: id.status,
            arn: id.arn,
            account: id.account,
            message: id.message,
            checkedAt: Date.now(),
          },
        },
      }));
    } catch (err) {
      set((st) => ({
        awsStatuses: {
          ...st.awsStatuses,
          [profile]: {
            status: "error",
            arn: null,
            account: null,
            message: String(err),
            checkedAt: Date.now(),
          },
        },
      }));
    }
  },

  openAwsAuthModal: (profile, ssoStartUrl) =>
    set({ awsAuthModal: { profile, ssoStartUrl } }),
  closeAwsAuthModal: () => set({ awsAuthModal: null }),

  runAwsSsoLogin: async (profile) => {
    const result = await awsApi.ssoLogin(profile);
    if (result.success) {
      await get().refreshAwsStatus(profile, true);
    }
    return result.success;
  },
});
