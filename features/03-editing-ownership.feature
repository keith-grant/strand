@editor @ownership @integrity
Feature: Editing prose around scene boundaries
  As a writer
  I want ordinary text edits to preserve scene ownership
  So that I can write naturally without damaging the manuscript structure

  Background:
    Given a project with a root manuscript named "Manuscript"
    And "Manuscript" contains the following content in order:
      | kind  | title  | text    |
      | prose |        | "Before " |
      | scene | Middle |         |
      | prose |        | " after." |
    And "Middle" contains the prose "inside"
    And I open "Manuscript" in the editor

  Scenario: Typing immediately before a child belongs to its parent
    Given I place the caret at the start of "Middle" on the parent side
    When I type "right "
    Then "Manuscript" should own the prose "Before right "
    And "Middle" should own the prose "inside"

  Scenario: Typing immediately inside a child belongs to the child
    Given I place the caret at the start of "Middle" on the child side
    When I type "just "
    Then "Middle" should own the prose "just inside"
    And "Manuscript" should own the prose "Before "
    And "Manuscript" should own the prose " after."

  Scenario: Typing immediately after a child belongs to its parent
    Given I place the caret at the end of "Middle" on the parent side
    When I type "and then"
    Then "Manuscript" should own the prose "and then after."
    And "Middle" should own the prose "inside"

  Scenario: Backspace at a child boundary does not remove the child
    Given I place the caret at the start of "Middle" on the child side
    When I press "Backspace"
    Then "Middle" should be a child of "Manuscript"
    And the assembled manuscript prose should be unchanged
    And the project structure should remain valid

  # Behaviour under discussion. Today the child's boundary survives but its text is deleted with the rest of
  # the selection, since the manuscript reads as one text; this scenario expects the child's text to survive.
  @todo
  Scenario: Deleting a selection across a complete child cannot silently destroy its structure
    Given I select from the text "Before " to the text " after."
    When I press "Delete"
    Then "Middle" should be a child of "Manuscript"
    And "Middle" should own the prose "inside"
    And the project structure should remain valid

  Scenario: Pasted text cannot introduce internal scene markers
    Given I place the caret at the start of "Middle" on the child side
    When I paste text containing reserved editor boundary characters
    Then the project should contain exactly 2 narrative nodes
    And the project structure should remain valid
