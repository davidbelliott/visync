#!/bin/bash
#
# concat-context.sh
#
# Simple shell script to concatenate files in the current directory and subdirectories
# into a single context.txt file for LLM consumption.
# Only includes files matching patterns in context-includes.txt.
#
cd "$(dirname "$0")"/..

# Get directory where the script is located
script_dir="$(dirname "$0")"
includes_file="$script_dir/context-includes.txt"
excludes_file="$script_dir/context-excludes.txt"
output_file="context.txt"

# Create/clear the output file
> "$output_file"

# Check if includes file exists
if [ ! -f "$includes_file" ]; then
  echo "Error: $includes_file not found. Please create this file with patterns to include."
  exit 1
fi

# Read include patterns into an array
include_patterns=()
while IFS= read -r line || [ -n "$line" ]; do
    if [ -n "$line" ]; then
        include_patterns+=("$line")
    fi
done < "$includes_file"
echo "Loaded ${#include_patterns[@]} include patterns from $includes_file"

exclude_patterns=()
while IFS= read -r line || [ -n "$line" ]; do
    if [ -n "$line" ]; then
        exclude_patterns+=("$line")
    fi
done < "$excludes_file"
echo "Loaded ${#exclude_patterns[@]} include patterns from $excludes_file"


# Find all files recursively, excluding directories
find . -type f | sort | while read -r file; do
  # Skip the output file itself
  if [[ "$file" == *"$output_file"* ]]; then
    continue
  fi

  # Check if file matches any include pattern
  include=0
  for pattern in "${include_patterns[@]}"; do
    # Skip empty patterns
    if [[ -z "$pattern" ]]; then
      continue
    fi
    
    if [[ "$file" == *"$pattern"* ]]; then
      include=1
      break
    fi
  done

  # Check if file matches any exclude pattern
  for pattern in "${exclude_patterns[@]}"; do
      if [[ "$file" == *"$pattern"* ]]; then
          echo "file in excludes: $file"
          include=0
          break
        fi
    done


  # Skip if it doesn't match any include pattern
  if [ $include -eq 0 ]; then
    continue
  fi

  # Append to output file with separator and filename
  #echo "Processing: $file"
  echo -e "\n=====\nFilename: $file\n" >> "$output_file"
  cat "$file" >> "$output_file"
done

echo "Concatenation complete. Output written to $output_file"
