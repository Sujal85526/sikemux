import { lazy } from "react";
import { registerFrontendPlugin } from "../../plugin-api";
import { ActionsOverlay } from "./components/ActionsOverlay";
import { ActionsTopBarItem } from "./components/ActionsTopBarItem";
import { GithubMark } from "./components/ActionsIcon";
import { GITHUB_PLUGIN_ID, GITHUB_ACTIONS } from "./kinds";
import { openActions, togglePalette } from "./state";

const ActionsPane = lazy(() => import("./components/ActionsPane").then((module) => ({ default: module.ActionsPane })));

registerFrontendPlugin({
    id: GITHUB_PLUGIN_ID,
    surfaces: [
        {
            kind: GITHUB_ACTIONS,
            title: "GitHub Actions",
            icon: (size) => <GithubMark size={size} />,
            render: ({ paneId, visible }) => <ActionsPane paneId={paneId} active={visible} />,
            quickOpen: togglePalette,
        },
    ],
    open: openActions,
    openTitle: "Open GitHub Actions",
    Overlay: ActionsOverlay,
    TopBarItem: ActionsTopBarItem,
});
