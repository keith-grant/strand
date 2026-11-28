@editor @structure @integrity
Feature: Restructuring the manuscript
  As a writer
  I want to split, merge and rearrange scenes
  So that structure can evolve with my draft

  Background:
    Given a project with a root manuscript named "Manuscript"

  Scenario: Splitting a scene preserves the assembled prose
    Given "Manuscript" contains a child scene "Encounter"
    And "Encounter" contains the prose "He entered. She stood."
    And I open "Manuscript" in the editor
    And I place the caret between "He entered." and "She stood."
    When I split "Encounter" at the caret
    Then "Manuscript" should contain exactly 2 child scenes
    And the two child scenes of "Manuscript" should own "He entered." and " She stood." in that order
    And the assembled manuscript prose should be unchanged

  Scenario: Merging adjacent siblings preserves their text order
    Given "Manuscript" contains the following content in order:
      | kind  | title  | text |
      | scene | First  |      |
      | scene | Second |      |
    And "First" contains the prose "One."
    And "Second" contains the prose "Two."
    And I open "Manuscript" in the editor
    When I merge "Second" into "First"
    Then "First" should own the prose "One.Two."
    And the project should not contain a scene named "Second"
    And the assembled manuscript prose should be unchanged

  Scenario: Merging a child into its parent removes only the boundary
    Given "Manuscript" contains the following content in order:
      | kind  | title  | text    |
      | prose |        | "Before " |
      | scene | Middle |         |
      | prose |        | " after" |
    And "Middle" contains the prose "during"
    And I open "Manuscript" in the editor
    When I merge "Middle" into its parent
    Then "Manuscript" should own the prose "Before during after"
    And the project should not contain a scene named "Middle"
    And the assembled manuscript prose should be unchanged

  Scenario: Moving a scene to a different parent preserves its contents
    Given "Manuscript" contains the following content in order:
      | kind  | title       | text |
      | scene | Chapter One |      |
      | scene | Chapter Two |      |
    And "Chapter One" contains a child scene "Encounter"
    And "Encounter" contains the prose "The meeting took place."
    When I move "Encounter" into "Chapter Two" using the manuscript tree
    Then "Encounter" should be a child of "Chapter Two"
    And "Encounter" should own the prose "The meeting took place."
    And "Chapter One" should not contain a child scene "Encounter"
    And the project structure should remain valid

  Scenario: A scene cannot be moved inside itself or its descendants
    Given "Manuscript" contains a child scene "Outer"
    And "Outer" contains a child scene "Inner"
    When I attempt to move "Outer" into "Inner" using the manuscript tree
    Then the move should be rejected
    And the project structure and prose should be unchanged

  Scenario: Undoing scene extraction restores the original structure
    Given "Manuscript" contains the prose "First. Second. Third."
    And I open "Manuscript" in the editor
    And I select the text "Second."
    When I create a child scene named "Middle" from the selection
    And I undo
    Then "Manuscript" should contain exactly 0 child scenes
    And "Manuscript" should own the prose "First. Second. Third."

  Scenario: Redoing scene extraction restores the same structure
    Given "Manuscript" contains the prose "First. Second. Third."
    And I open "Manuscript" in the editor
    And I select the text "Second."
    When I create a child scene named "Middle" from the selection
    And I undo
    And I redo
    Then "Middle" should be a child of "Manuscript"
    And "Middle" should own the prose "Second."
    And the assembled manuscript prose should be unchanged
