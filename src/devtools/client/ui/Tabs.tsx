import {
  Tab as BaseTab,
  TabGroup as BaseTabGroup,
  TabList as BaseTabList,
  TabPanel as BaseTabPanel,
} from 'terracotta/tabs';

import './Tabs.css';

export const Tab: typeof BaseTab = (props) => <BaseTab data-solid-tab {...props} />;
export const TabGroup: typeof BaseTabGroup = (props) => (
  <BaseTabGroup data-solid-tab-group {...props} />
);
export const TabPanel: typeof BaseTabPanel = (props) => (
  <BaseTabPanel data-solid-tab-panel {...props} />
);
export const TabList: typeof BaseTabList = (props) => (
  <BaseTabList data-solid-tab-list {...props} />
);
