import { lazy } from "react";
import { IconRundeck } from "../../components/Icons";
import * as cmd from "../../state/commands";
import { registerFrontendPlugin } from "../registry";
import { RUNDECK_DEPLOY, RUNDECK_PLUGIN_ID } from "./kinds";

const RundeckPane = lazy(() => import("../../components/rundeck/RundeckPane").then((module) => ({ default: module.RundeckPane })));

registerFrontendPlugin({
    id: RUNDECK_PLUGIN_ID,
    surfaces: [
        {
            kind: RUNDECK_DEPLOY,
            title: "Rundeck",
            icon: (size) => <IconRundeck size={size} />,
            render: ({ paneId, visible }) => <RundeckPane paneId={paneId} active={visible} />,
        },
    ],
    open: cmd.openRundeckSession,
    openTitle: "Open Rundeck deploy center",
});
