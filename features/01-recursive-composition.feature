@editor @composition
Feature: Recursive manuscript composition
  As a writer
  I want nested scenes to read as one continuous manuscript
  So that structure does not interrupt the act of writing

  Background:
    Given a project with a root manuscript named "Manuscript"

  Scenario: Parent prose appears before and after an embedded scene
    Given "Manuscript" contains the following content in order:
      | kind  | title         | text                         |
      | prose |               | "The door was locked."       |
      | scene | The Discovery | "The key lay under the mat." |
      | prose |               | "She turned and left."       |
    When I open "Manuscript" in the editor
    Then the editor should show the assembled prose of "Manuscript" in order
    And "The Discovery" should have a visible scene boundary
    And the editor should be a single continuous editing surface

  Scenario: Scenes can be nested to multiple levels
    Given "Manuscript" contains a child scene "Chapter One"
    And "Chapter One" contains a child scene "The Argument"
    And "The Argument" contains the prose "Anna put down the letter."
    When I open "Manuscript" in the editor
    Then the editor should show the prose "Anna put down the letter."
    And "Chapter One" should have a visible scene boundary
    And "The Argument" should have a visible scene boundary

  Scenario: Opening a scene shows only that scene and its descendants
    Given "Manuscript" contains the following content in order:
      | kind  | title       | text                 |
      | scene | Chapter One | "The first morning." |
      | scene | Chapter Two | "The next morning."  |
    When I open "Chapter One" in the editor
    Then the editor should show the prose "The first morning."
    And the editor should not show the prose "The next morning."

  Scenario: An empty scene is still part of the hierarchy
    Given "Manuscript" contains a child scene "Unwritten Scene"
    When I open "Manuscript" in the editor
    Then "Unwritten Scene" should have a visible scene boundary
    When I place the caret at the start of "Unwritten Scene" on the child side
    And I type "New prose."
    Then "Unwritten Scene" should own the prose "New prose."
