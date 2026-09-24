import { lazy } from "react";
import { registerFrontendPlugin } from "../../plugin-api";
import { SignozIcon } from "./components/SignozIcon";
import { SIGNOZ_EXPLORE, SIGNOZ_PLUGIN_ID } from "./kinds";
import { openSignoz } from "./state";
import "./signoz.css";

const SignozPane = lazy(() => import("./components/SignozPane").then((module) => ({ default: module.SignozPane })));

registerFrontendPlugin({
    id: SIGNOZ_PLUGIN_ID,
    surfaces: [
        {
            kind: SIGNOZ_EXPLORE,
            title: "SigNoz",
            icon: (size) => <SignozIcon size={size} />,
            render: ({ paneId, visible }) => <SignozPane paneId={paneId} active={visible} />,
        },
    ],
    open: openSignoz,
    openTitle: "Open SigNoz",
});
