@editor @navigation
Feature: Navigating and collapsing scenes
  As a writer
  I want to hide and focus on parts of my manuscript
  So that I can concentrate without losing context

  Background:
    Given a project with a root manuscript named "Manuscript"
    And "Manuscript" contains the following content in order:
      | kind  | title   | text          |
      | prose |         | "Introduction." |
      | scene | A Story |               |
      | prose |         | "Conclusion."   |
    And "A Story" contains the prose "Once upon a time."
    And "A Story" contains a child scene "An Aside"
    And "An Aside" contains the prose "A detail worth remembering."
    And I open "Manuscript" in the editor

  Scenario: Collapsing a child hides its content but retains surrounding prose
    When I collapse "A Story"
    Then the editor should not show the prose "Once upon a time."
    And the editor should not show the prose "A detail worth remembering."
    And "A Story" should have a visible collapsed placeholder
    And the editor should show the prose "Introduction."
    And the editor should show the prose "Conclusion."
    And the assembled manuscript prose should be unchanged

  Scenario: Expanding a child restores its editable content
    Given "A Story" is collapsed
    When I expand "A Story"
    Then the editor should show the prose "Once upon a time."
    And "An Aside" should have a visible scene boundary
    When I place the caret at the start of "A Story" on the child side
    And I type "Suddenly, "
    Then "A Story" should own the prose "Suddenly, Once upon a time."

  Scenario: Collapsing a nested scene leaves its parent visible
    When I collapse "An Aside"
    Then the editor should show the prose "Once upon a time."
    And the editor should not show the prose "A detail worth remembering."
    And "An Aside" should have a visible collapsed placeholder
    And the assembled manuscript prose should be unchanged

  Scenario: Opening a nested scene gives it its own editing focus
    When I open "An Aside" in the editor
    Then the editor should show the prose "A detail worth remembering."
    And "An Aside" should be the opened node
    And the editor should not show the prose "Introduction."

  Scenario: Collapsing a scene containing the caret leaves a usable caret
    Given I place the caret at the start of "A Story" on the child side
    When I collapse "A Story"
    Then the caret should be outside the collapsed content of "A Story"
    When I place the caret at the end of "Manuscript" on the parent side
    And I type " Continued."
    Then "Manuscript" should own the prose "Conclusion. Continued."
