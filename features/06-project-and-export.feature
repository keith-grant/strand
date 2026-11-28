@project @persistence
Feature: Preserving and exporting a manuscript
  As a writer
  I want my manuscript preserved and exportable
  So that I can trust the application with my work

  Scenario: Saving and reopening preserves the narrative hierarchy
    Given a project with a root manuscript named "Manuscript"
    And "Manuscript" contains the following content in order:
      | kind  | title      | text                 |
      | prose |            | "Before "            |
      | scene | The Letter | "She read the note." |
      | prose |            | "After"              |
    When I save the project
    And I close the project
    And I reopen the saved project
    Then "The Letter" should retain its scene identity
    And "The Letter" should be a child of "Manuscript"
    And "The Letter" should own the prose "She read the note."
    And "Manuscript" should own the prose "Before "
    And "Manuscript" should own the prose "After"
    And the assembled manuscript prose should be unchanged

  Scenario: Autosave preserves recent edits
    Given a saved project with a root manuscript named "Manuscript"
    And "Manuscript" contains the prose "Original."
    And I open "Manuscript" in the editor
    When I place the caret at the end of "Manuscript" on the parent side
    And I type " Updated."
    And autosave completes
    And I reopen the saved project
    Then "Manuscript" should own the prose "Original. Updated."
    And the project structure should remain valid

  Scenario: Markdown export resolves child references recursively
    Given a project with a root manuscript named "Manuscript"
    And "Manuscript" contains the following content in order:
      | kind  | title  | text      |
      | prose |        | "Before " |
      | scene | Middle | "inside"  |
      | prose |        | " after." |
    When I export the manuscript as Markdown
    Then the exported Markdown should equal "Before inside after."
    And the exported Markdown should contain no scene references or editor markers
    And export should not change the saved project

  Scenario: Word counts distinguish owned prose from descendants
    Given a project with a root manuscript named "Manuscript"
    And "Manuscript" contains the prose "one two"
    And "Manuscript" contains a child scene "Middle"
    And "Middle" contains the prose "three four five"
    When I view the word counts
    Then "Manuscript" should report 2 owned words
    And "Manuscript" should report 5 aggregate words
    And "Middle" should report 3 owned words
