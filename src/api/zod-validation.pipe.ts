import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { formatZodIssues } from '../common/json';

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'invalid_input',
        message: 'Request validation failed',
        issues: formatZodIssues(result.error),
      });
    }
    return result.data;
  }
}
