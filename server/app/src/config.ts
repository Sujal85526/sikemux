/** Where the web app finds the API and Clerk. Both are public; a dev server talks to the API on this machine. */
export const config = import.meta.env.DEV
  ? {
      apiUrl: "http://127.0.0.1:4000",
      clerkPublishableKey:
        "pk_test_aW1tZW5zZS1sbGFtYS02NjY4LmNsZXJrLmFjY291bnRzLmRldiQ",
    }
  : {
      apiUrl: "https://api.sikemux.com",
      clerkPublishableKey: "pk_live_Y2xlcmsuc2lrZW11eC5jb20k",
    };
