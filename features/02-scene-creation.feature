@editor @structure
Feature: Creating scenes while writing
  As a writer
  I want to introduce structure without disrupting prose
  So that outlines can gradually become detailed scenes

  Background:
    Given a project with a root manuscript named "Manuscript"
    And "Manuscript" contains the prose:
      """
      She arrived before dawn.

      The letter was waiting on the table.

      Nobody had seen who delivered it.
      """
    And I open "Manuscript" in the editor

  Scenario: Extracting selected prose preserves its position and text
    Given I select the text "The letter was waiting on the table."
    When I create a child scene named "The Letter" from the selection
    Then "The Letter" should be a child of "Manuscript"
    And "The Letter" should own the prose "The letter was waiting on the table."
    And "Manuscript" should own the prose "She arrived before dawn."
    And "Manuscript" should own the prose "Nobody had seen who delivered it."
    And the assembled manuscript prose should be unchanged
    And "The Letter" should appear inline at the original selection position

  Scenario: Inserting an empty child at the caret
    Given I place the caret between "dawn." and "The letter"
    When I insert an empty child scene named "Arrival" at the caret
    Then "Arrival" should be a child of "Manuscript"
    And "Arrival" should own no prose
    And "Arrival" should appear inline at the original caret position
    And the assembled manuscript prose should be unchanged

  Scenario: Extracting prose from a child creates a grandchild
    Given I select all prose in the editor
    And I create a child scene named "Opening" from the selection
    And I select the text "The letter was waiting on the table."
    When I create a child scene named "The Letter" from the selection
    Then "The Letter" should be a child of "Opening"
    And "The Letter" should own the prose "The letter was waiting on the table."
    And the assembled manuscript prose should be unchanged

  Scenario: Structural commands are available contextually
    Given I select the text "The letter was waiting on the table."
    When I open the editor context menu
    Then the editor context menu should contain "Create child from selection"
    When I clear the selection
    And I open the editor context menu
    Then the editor context menu should contain "Insert child here"
