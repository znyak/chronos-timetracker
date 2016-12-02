import React, { PropTypes } from 'react';

import Avatar from '../Avatar/Avatar';
import Dropdown from '../Dropdown/Dropdown';
import Flex from '../Base/Flex/Flex';

const Header = (props) => {
  const {
    avatarUrl,
    username,
    projects,
    currentProject,
    currentProjectId,
    onProjectChange,
  } = props;
  const dropdownOptions = [];
  for (const entry of projects.entries()) {
    const [i, project] = entry;
    dropdownOptions.push({
      value: i,
      label: project.get('name'),
    });
  }
  const value =
    currentProjectId !== null ? {
      value: currentProjectId,
      label: currentProject.get('name'),
    } : undefined;

  return (
    <Flex column className="header">
      <Flex row>
        <Avatar avatarUrl={avatarUrl} />
        <Flex column centered>
          <span className="username">
            {username}
          </span>
        </Flex>
      </Flex>
      <Dropdown
        options={dropdownOptions}
        onChange={onProjectChange}
        value={value}
      />
    </Flex>
  );
};

Header.propTypes = {
  avatarUrl: PropTypes.string.isRequired,
  username: PropTypes.string.isRequired,
  projects: PropTypes.object,
  currentProject: PropTypes.object,
  currentProjectId: PropTypes.number,
  onProjectChange: PropTypes.func.isRequired,
};

export default Header;